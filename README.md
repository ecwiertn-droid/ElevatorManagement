# Elevator Tag

A tagging and work order application for an elevator maintenance company.

- A technician adds an elevator on the first visit and gets a QR tag for it.
- On every later visit the technician scans the tag, sees past work, and sends a work order to the owner.
- The owner reviews every work order, sends the invoice by email, and sees all work on a dashboard.

## How it is built

| Part | Where | What it does |
| --- | --- | --- |
| Web page | `public/` | The whole application: one HTML page, one stylesheet, one script. No build step. |
| Server functions | `api/`, `lib/` | Three small functions that run on Vercel: tell the page where the database is, create logins, send invoice email. |
| Database | `supabase/schema.sql` | Tables, numbering, and the rules for who can read or change what. Runs on Supabase. |

Who can do what is enforced by the database rules, not by the web page.

| Role | Can do |
| --- | --- |
| Owner | Everything |
| Technician | See records, add elevators, send work orders for review in their own name |
| Waiting / Turned off | Nothing |

## Setup

### 1. Supabase

1. Create a project at supabase.com.
2. Open the SQL editor, paste the whole of `supabase/schema.sql`, and run it.
3. Under Authentication, Users, add your own user with an email and password, and mark it as confirmed. The first user becomes the owner.
4. Under Authentication, turn off "Allow new users to sign up". People are added from inside the application instead.
5. From the project's API settings, copy the project URL, the publishable key, and the secret key.

### 2. Vercel

In the Vercel project, open Settings, Environment Variables, and add:

| Name | Value | Needed for |
| --- | --- | --- |
| `SUPABASE_URL` | The Supabase project URL | Everything |
| `SUPABASE_PUBLISHABLE_KEY` | The publishable key (safe for browsers) | Everything |
| `SUPABASE_SECRET_KEY` | The secret key. Never put this anywhere else. | Adding people and setting passwords from Setup |
| `RESEND_API_KEY` | An API key from resend.com | Emailing invoices |
| `EMAIL_FROM` | For example `Company Name <invoices@yourdomain.com>` | Emailing invoices |

Redeploy after adding or changing variables. The older Supabase key names (`SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) also work.

Email needs a domain verified in Resend. Until the two email variables are set, the owner can still approve work orders and mark them as sent, but nothing is emailed.

### 3. First sign in

1. Open the site and sign in with the user from step 1.3.
2. In Setup: enter the company name and owner email, check the visit types, and add the technicians.
3. In Saved items: enter the items and prices.
4. Switch to Field and add the first elevator.

## What is not included yet

- Reading the text from the certificate photo. The photo is stored; the technician types the details.
- Working without signal. The technician needs a connection to save.
- Sales tax on invoices.
- Passing invoices to accounting software.
- Deleting elevators or work orders.

## Known limits

- The "Technicians see prices" switch hides prices on the technician's screen. It does not stop a technician with technical skill from reading the price list through the database.
- A technician's work order stores the prices at the time it was sent. The owner checks them during review.
- The page loads the most recent 2,000 work orders.

## Testing done before delivery

- `supabase/schema.sql` was run twice on PostgreSQL 16 and the access rules were tested for owner, technician, waiting, turned-off and signed-out users.
- The three server functions were run with stand-in Supabase and Resend responses.
- The web page was run through its full flow in a test browser against a stand-in for Supabase.

It has not yet been run against a real Supabase project, a real Resend account, or on Vercel.
