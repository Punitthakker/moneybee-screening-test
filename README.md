# MoneyBee Screening Test

A small web page to test name screening. Type a person or company, get matches from the UN Security Council consolidated sanctions list with a score out of 100.

## Run it (Mac or Windows)

1. Install Node.js 18 or newer from https://nodejs.org (skip if `node -v` already works).
2. Open Terminal in this folder and run:

```bash
npm install
npm start
```

3. Open http://localhost:3000

On start it downloads the live UN list (a few MB) and keeps a copy in `data/`. The banner at the top of the page shows which source is in use. If it says FICTIONAL SAMPLE DATA, the download failed and you are only testing against 3 made-up names (try "Alex Demoson" or "Demo Trading Company").

## Run it with Docker instead

1. Install Docker Desktop and make sure it is running.
2. In this folder run:

```bash
docker compose up -d --build
```

3. Open http://localhost:3000

Useful commands: `docker compose logs -f` to watch it load the UN list, `docker compose down` to stop it. The downloaded list is kept in a Docker volume, so restarts are fast and work offline.

To also query Watchman, uncomment the `WATCHMAN_URL` line in `docker-compose.yml`.

## How to read results

- 90 and above: strong match, a person should review.
- 70 to 89: possible match, a person should review.
- Nothing listed: no name scored 70 or above.

Matching is by name only. It handles spelling variants and aliases but does not use date of birth or country yet, so common names can produce false hits.

## Also query Watchman (optional)

If you run a Watchman instance, point the page at it and its raw response shows under the UN matches:

```bash
WATCHMAN_URL=http://localhost:8084 npm start
```

Watchman changed its API between versions, so the page tries `/v2/search` first and then `/search`. Adjust the port to match your setup.

## Not covered yet

UAE Local Terrorist List, OFAC SDN, and PEPs. See LIVE_DATA.md in the moneybee-risk-datasources repo. For testing only, not a compliance decision.

## Self-test

```bash
npm test
```
