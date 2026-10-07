-- Elevator Tag: database setup for Supabase.
-- Run this whole file once in the Supabase SQL editor. It is safe to run again.
--
-- Who can do what is enforced here, in the database, not in the web page:
--   owner       everything
--   technician  read records, add elevators, send work orders for review
--   pending     nothing (a new login the owner has not turned on yet)
--   disabled    nothing

-- ---------------------------------------------------------------- tables

create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  email text not null default '',
  name text not null default '',
  role text not null default 'pending' check (role in ('owner', 'technician', 'pending', 'disabled')),
  created_at timestamptz not null default now()
);

create table if not exists public.settings (
  id int primary key default 1 check (id = 1),
  company_name text not null default '',
  owner_email text not null default '',
  show_prices_to_tech boolean not null default true
);
insert into public.settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.visit_types (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sort int not null default 0
);
create unique index if not exists visit_types_name_key on public.visit_types (lower(name));

insert into public.visit_types (name, sort)
select v.name, v.sort
from (values ('Maintenance', 1), ('Trouble call', 2), ('Repair', 3), ('Test', 4)) as v(name, sort)
where not exists (select 1 from public.visit_types);

create table if not exists public.items (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  price numeric(10, 2) not null default 0 check (price >= 0),
  sort int not null default 0
);

create table if not exists public.elevators (
  id text primary key check (id ~ '^e-[a-z0-9]{6,24}$'),
  cert_number text not null,
  state text not null default '',
  address text not null,
  city text not null default '',
  building_name text not null default '',
  unit_label text not null default '',
  inspection_date date,
  owner_name text not null default '',
  contact_name text not null default '',
  contact_phone text not null default '',
  emails text[] not null default '{}',
  notes text not null default '',
  needs_info boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles
);
create unique index if not exists elevators_cert_number_key on public.elevators (lower(cert_number));

create table if not exists public.elevator_photos (
  elevator_id text primary key references public.elevators on delete cascade,
  data_url text not null check (length(data_url) < 400000),
  created_at timestamptz not null default now()
);

create sequence if not exists public.work_order_seq;
create sequence if not exists public.invoice_seq;

create table if not exists public.work_orders (
  id uuid primary key default gen_random_uuid(),
  number text not null unique default ('WO-' || lpad(nextval('public.work_order_seq')::text, 4, '0')),
  elevator_id text not null references public.elevators,
  technician_id uuid not null references public.profiles,
  visit_type text not null,
  lines jsonb not null default '[]'::jsonb,
  notes text not null default '',
  status text not null default 'review' check (status in ('review', 'approved', 'sent')),
  total numeric(12, 2) not null default 0,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  invoice_number text unique,
  sent_to text,
  copy_to text,
  sent_at timestamptz,
  emailed boolean not null default false
);
create index if not exists work_orders_elevator_idx on public.work_orders (elevator_id);
create index if not exists work_orders_status_idx on public.work_orders (status);

-- ---------------------------------------------------------------- functions

-- The role of the person making the request, or null when they have none.
create or replace function public.app_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select role from public.profiles where id = (select auth.uid());
$$;

-- Every new login gets a profile. The very first one becomes the owner;
-- everyone after that waits until the owner turns them on.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, name, role)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'name', ''),
    case when exists (select 1 from public.profiles where role = 'owner') then 'pending' else 'owner' end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Logins that existed before this file was run.
insert into public.profiles (id, email, name, role)
select u.id, coalesce(u.email, ''), coalesce(u.raw_user_meta_data ->> 'name', ''), 'pending'
from auth.users u
on conflict (id) do nothing;

update public.profiles
set role = 'owner'
where id = (select id from auth.users order by created_at asc limit 1)
  and not exists (select 1 from public.profiles where role = 'owner');

-- There is always at least one owner.
create or replace function public.keep_one_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.role = 'owner'
     and (tg_op = 'DELETE' or new.role <> 'owner')
     and not exists (select 1 from public.profiles where role = 'owner' and id <> old.id) then
    raise exception 'There must be at least one owner.';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_keep_one_owner on public.profiles;
create trigger profiles_keep_one_owner
  before update or delete on public.profiles
  for each row execute function public.keep_one_owner();

-- The total is always worked out from the lines, never taken from the browser.
create or replace function public.work_order_total()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.total := coalesce((
    select sum(greatest((l ->> 'qty')::numeric, 0) * greatest((l ->> 'price')::numeric, 0))
    from jsonb_array_elements(new.lines) as l
  ), 0);
  return new;
end;
$$;

drop trigger if exists work_orders_total on public.work_orders;
create trigger work_orders_total
  before insert or update on public.work_orders
  for each row execute function public.work_order_total();

-- Gives a work order its invoice number the first time it is invoiced.
create or replace function public.assign_invoice_number(p_id uuid)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_number text;
begin
  if public.app_role() is distinct from 'owner' then
    raise exception 'Only the owner can invoice.';
  end if;
  update public.work_orders
  set invoice_number = 'INV-' || lpad(nextval('public.invoice_seq')::text, 4, '0')
  where id = p_id and invoice_number is null and status in ('approved', 'sent');
  select invoice_number into v_number from public.work_orders where id = p_id;
  return v_number;
end;
$$;

-- ---------------------------------------------------------------- access rules

alter table public.profiles enable row level security;
alter table public.settings enable row level security;
alter table public.visit_types enable row level security;
alter table public.items enable row level security;
alter table public.elevators enable row level security;
alter table public.elevator_photos enable row level security;
alter table public.work_orders enable row level security;

grant usage on schema public to authenticated;
grant select, update on public.profiles to authenticated;
grant select, update on public.settings to authenticated;
grant select, insert, update, delete on public.visit_types to authenticated;
grant select, insert, update, delete on public.items to authenticated;
grant select, insert, update on public.elevators to authenticated;
grant select, insert on public.elevator_photos to authenticated;
grant select, insert, update on public.work_orders to authenticated;
grant usage on sequence public.work_order_seq to authenticated;
grant usage on sequence public.invoice_seq to authenticated;
grant execute on function public.app_role() to authenticated;
grant execute on function public.assign_invoice_number(uuid) to authenticated;

-- People: you can see yourself; staff can see each other; only the owner changes anyone.
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (id = (select auth.uid()) or public.app_role() in ('owner', 'technician'));

drop policy if exists profiles_owner_update on public.profiles;
create policy profiles_owner_update on public.profiles for update to authenticated
  using (public.app_role() = 'owner') with check (public.app_role() = 'owner');

-- Company settings.
drop policy if exists settings_read on public.settings;
create policy settings_read on public.settings for select to authenticated
  using (public.app_role() in ('owner', 'technician'));

drop policy if exists settings_owner_update on public.settings;
create policy settings_owner_update on public.settings for update to authenticated
  using (public.app_role() = 'owner') with check (public.app_role() = 'owner');

-- Visit types and saved items: staff read, owner changes.
drop policy if exists visit_types_read on public.visit_types;
create policy visit_types_read on public.visit_types for select to authenticated
  using (public.app_role() in ('owner', 'technician'));

drop policy if exists visit_types_owner_insert on public.visit_types;
create policy visit_types_owner_insert on public.visit_types for insert to authenticated
  with check (public.app_role() = 'owner');

drop policy if exists visit_types_owner_update on public.visit_types;
create policy visit_types_owner_update on public.visit_types for update to authenticated
  using (public.app_role() = 'owner') with check (public.app_role() = 'owner');

drop policy if exists visit_types_owner_delete on public.visit_types;
create policy visit_types_owner_delete on public.visit_types for delete to authenticated
  using (public.app_role() = 'owner');

drop policy if exists items_read on public.items;
create policy items_read on public.items for select to authenticated
  using (public.app_role() in ('owner', 'technician'));

drop policy if exists items_owner_insert on public.items;
create policy items_owner_insert on public.items for insert to authenticated
  with check (public.app_role() = 'owner');

drop policy if exists items_owner_update on public.items;
create policy items_owner_update on public.items for update to authenticated
  using (public.app_role() = 'owner') with check (public.app_role() = 'owner');

drop policy if exists items_owner_delete on public.items;
create policy items_owner_delete on public.items for delete to authenticated
  using (public.app_role() = 'owner');

-- Elevators: staff read and add; only the owner edits.
drop policy if exists elevators_read on public.elevators;
create policy elevators_read on public.elevators for select to authenticated
  using (public.app_role() in ('owner', 'technician'));

drop policy if exists elevators_staff_insert on public.elevators;
create policy elevators_staff_insert on public.elevators for insert to authenticated
  with check (public.app_role() in ('owner', 'technician') and created_by = (select auth.uid()));

drop policy if exists elevators_owner_update on public.elevators;
create policy elevators_owner_update on public.elevators for update to authenticated
  using (public.app_role() = 'owner') with check (public.app_role() = 'owner');

drop policy if exists elevator_photos_read on public.elevator_photos;
create policy elevator_photos_read on public.elevator_photos for select to authenticated
  using (public.app_role() in ('owner', 'technician'));

drop policy if exists elevator_photos_staff_insert on public.elevator_photos;
create policy elevator_photos_staff_insert on public.elevator_photos for insert to authenticated
  with check (public.app_role() in ('owner', 'technician'));

-- Work orders: staff read. A technician can only add one in their own name and
-- only as "waiting for review". Everything after that is the owner's.
drop policy if exists work_orders_read on public.work_orders;
create policy work_orders_read on public.work_orders for select to authenticated
  using (public.app_role() in ('owner', 'technician'));

drop policy if exists work_orders_staff_insert on public.work_orders;
create policy work_orders_staff_insert on public.work_orders for insert to authenticated
  with check (
    status = 'review'
    and invoice_number is null
    and sent_at is null
    and (
      public.app_role() = 'owner'
      or (public.app_role() = 'technician' and technician_id = (select auth.uid()))
    )
  );

drop policy if exists work_orders_owner_update on public.work_orders;
create policy work_orders_owner_update on public.work_orders for update to authenticated
  using (public.app_role() = 'owner') with check (public.app_role() = 'owner');
