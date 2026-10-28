# MoneyBee Screening

Customer screening for onboarding: name, date of birth, nationality and ID checks against sanctions lists, with login, review workflow, PDF reports, batch upload and ongoing monitoring. Built for UAE go live.

## What is screened

| List | Source | How it is loaded |
| --- | --- | --- |
| UN Security Council consolidated | UN XML feed | automatic, every 6 hours |
| OFAC SDN (US) | OFAC XML feed | automatic |
| EU consolidated financial sanctions | EU FSF XML feed | automatic |
| UK Sanctions List | FCDO XML feed | automatic |
| Canada (SEMA), Switzerland (SECO), Australia (DFAT) | official XML and Excel feeds | automatic, optional lists. Parsers follow the published layouts and are confirmed by the first live load shown on the Lists page |
| UAE Local Terrorist List (EOCN) | published only as PDF or Excel | admin uploads the official .xlsx on the Lists page; it is read as published (individuals, organisations, entities, delisted names ignored) and the screen reports what was added or removed. A copy supplied with the product loads on first start |
| Custom list | your own watchlist | admin upload (optional) |
| FATF black and grey lists, UN country regimes | editable country lists | admin edits and marks as verified |

Paid providers (PEP, adverse media, INTERPOL, FBI, Europe's Most Wanted, FIU India) are shown as **Not connected** on screen and on every report. They are never reported as screened. Add an adapter in `lib/providers.js` to connect one.

A screening is marked **incomplete** when a required list has no data or is older than 48 hours. Do not treat a clear result on an incomplete screening as clear.

## Security and compliance features

* **ID numbers encrypted at rest** (AES-256-GCM) with a keyed blind index so customers can still be found by ID. Set `ID_ENC_KEY` to a random value on the server and keep it safe: without it the numbers cannot be read.
* **Retention rule** (Settings): delete customers not screened for 5 to 30 years. Off by default. Customers with a confirmed match are always kept.
* **Two-factor sign in** (authenticator app, recovery codes). Administrators can require it for everyone.
* **Four-eyes approval** (Settings): a confirmed true match needs a different person to approve it.
* **Notifications**: Slack-compatible webhook (public https addresses only) and email when `SMTP_URL` is set. Messages never contain ID numbers.
* **Risk rating and periodic review**: every customer gets a high, medium or low rating with the reasons listed, an optional override with a reason, and a next review date (default 6, 12 and 36 months).
* **Client separation**: clients, client users and per-client records. A client user can never read another client's data.
* **Full backup and restore**: a platform administrator can download a complete backup (every client, customer, screening, decision and the audit log) as one JSON file from Settings. ID numbers and two-factor secrets stay encrypted inside it, so it is useless without `ID_ENC_KEY`. Restore with `node scripts/restore.js <file> --confirm` against the target `DATABASE_URL` (same `ID_ENC_KEY`). Downloadable sanctions feeds are left out because they refresh themselves.

## Run locally

```
export DATABASE_URL=postgres://user:pass@localhost:5432/screening
export SESSION_SECRET=$(openssl rand -hex 32)
export ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a-long-password-1'
npm ci && npm start
```

The first administrator is created from `ADMIN_EMAIL` and `ADMIN_PASSWORD` and must change the password at first sign in.

Other settings: `ID_ENC_KEY`, `SMTP_URL`, `MAIL_FROM`, `CANADA_URLS`, `SWISS_URLS`, `AUSTRALIA_URLS`, `PORT`, `NODE_ENV=production`, `DATABASE_SSL=true`, `REFRESH_HOURS`, `STALE_HOURS`, `DISABLE_FEEDS=true`, and `UN_URLS`, `OFAC_URLS`, `EU_URLS`, `UK_URLS` to override feed addresses.

## Tests

```
npm test                                    # unit tests
TEST_DATABASE_URL=postgres://... npm test   # adds end to end tests (wipes that database)
```

## Go live checklist

1. Sign in, change the password, add users (analyst screens and reviews, viewer is read only).
2. Lists page: confirm UN, OFAC, EU, UK show Ready.
3. Download the current UAE Local Terrorist List workbook from the EOCN site and upload it as it is. Repeat on every change. The copy supplied with the product goes out of date after 48 hours and screenings are then marked incomplete.
4. Check the FATF and UN country lists against the official pages, edit if needed, press Mark as verified.
5. Set default scan criteria and the security controls under Settings (four-eyes, two-factor, retention, review months, notifications). Turn on two-factor for your own account first.
6. Screen a few known names and download the PDF.
7. Store `ID_ENC_KEY` somewhere safe and separate (a password manager). Without it, stored ID numbers cannot be read or restored.
8. Download a full backup from Settings and confirm you can keep it somewhere other than Railway. Railway's own database backups depend on your plan: check they are on.

## Open items

* Paid providers (PEP, adverse media, INTERPOL, FBI, Europe's Most Wanted, FIU India) are not connected. This needs a provider choice and budget.
* Canada, Switzerland and Australia parsers are built from the published layouts. Check the record counts after the first live download.
* The UAE list is a manual upload each time EOCN publishes a change, because EOCN offers no machine-readable feed.
* Arabic script names are matched on their transliterated forms and are not drawn in the PDF.
* Sessions last 8 hours. The login brake is in memory and resets on restart.
* Railway does not redeploy on push for this service. Redeploy from the dashboard after pushing.
