# MoneyBee Screening

Customer screening for onboarding: name, date of birth, nationality and ID checks against sanctions lists, with login, review workflow, PDF reports, batch upload and ongoing monitoring. Built for UAE go live.

## What is screened

| List | Source | How it is loaded |
| --- | --- | --- |
| UN Security Council consolidated | UN XML feed | automatic, every 6 hours |
| OFAC SDN (US) | OFAC XML feed | automatic |
| EU consolidated financial sanctions | EU FSF XML feed | automatic |
| UK Sanctions List | FCDO XML feed | automatic |
| UAE Local Terrorist List (EOCN) | published only as PDF or Excel | admin uploads .xlsx or .csv on the Lists page |
| Custom list | your own watchlist | admin upload (optional) |
| FATF black and grey lists, UN country regimes | editable country lists | admin edits and marks as verified |

Paid providers (PEP, adverse media, INTERPOL, FBI, Europe's Most Wanted, FIU India) are shown as **Not connected** on screen and on every report. They are never reported as screened. Add an adapter in `lib/providers.js` to connect one.

A screening is marked **incomplete** when a required list has no data or is older than 48 hours. Do not treat a clear result on an incomplete screening as clear.

## Run locally

```
export DATABASE_URL=postgres://user:pass@localhost:5432/screening
export SESSION_SECRET=$(openssl rand -hex 32)
export ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a-long-password-1'
npm ci && npm start
```

The first administrator is created from `ADMIN_EMAIL` and `ADMIN_PASSWORD` and must change the password at first sign in.

Other settings: `PORT`, `NODE_ENV=production`, `DATABASE_SSL=true`, `REFRESH_HOURS`, `STALE_HOURS`, `DISABLE_FEEDS=true`, and `UN_URLS`, `OFAC_URLS`, `EU_URLS`, `UK_URLS` to override feed addresses.

## Tests

```
npm test                                    # unit tests
TEST_DATABASE_URL=postgres://... npm test   # adds end to end tests (wipes that database)
```

## Go live checklist

1. Sign in, change the password, add users (analyst screens and reviews, viewer is read only).
2. Lists page: confirm UN, OFAC, EU, UK show Ready.
3. Download the current UAE Local Terrorist List from the EOCN site, save as .xlsx or .csv, upload it, check the column mapping. Repeat on every change. Until then every screening is incomplete.
4. Check the FATF and UN country lists against the official pages, edit if needed, press Mark as verified.
5. Set default scan criteria under Settings.
6. Screen a few known names and download the PDF.

## Open items

* Paid providers are not connected.
* Arabic script names are matched on their transliterated forms and are not drawn in the PDF.
* ID numbers are stored in the database in plain text. Decide on encryption and a retention period before handling live customer data.
* The UAE list is a manual upload. Set a reminder to refresh it.
* Sessions last 8 hours. The login brake is in memory and resets on restart.
* Railway does not redeploy on push for this service. Redeploy from the dashboard after pushing.
