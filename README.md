<p align="center"><img src="https://github.com/MauriaApp.png" width="96" alt="MauriaApp"></p>

<p align="center">
<a href="https://nodejs.org"><img alt="Node 22.13+" src="https://img.shields.io/badge/node-22.13%2B-5FA04E?logo=nodedotjs&logoColor=white"></a>
<a href="https://fastify.dev"><img alt="Fastify 5" src="https://img.shields.io/badge/fastify-5-000000?logo=fastify&logoColor=white"></a>
<a href="https://www.typescriptlang.org"><img alt="TypeScript 7" src="https://img.shields.io/badge/typescript-7-3178C6?logo=typescript&logoColor=white"></a>
<a href="https://supabase.com/docs/reference/javascript"><img alt="Supabase PostgREST 2" src="https://img.shields.io/badge/supabase-postgrest%202-3FCF8E?logo=supabase&logoColor=white"></a>
<a href="https://docs.sentry.io/platforms/javascript/guides/node/"><img alt="Sentry 11" src="https://img.shields.io/badge/sentry-11%2C%20no%20PII-362D59?logo=sentry&logoColor=white"></a>
<a href="https://fly.io/docs"><img alt="Fly.io 256 MB" src="https://img.shields.io/badge/fly.io-256%20MB-24175B?logo=flydotio&logoColor=white"></a>
<a href="https://prettier.io"><img alt="Prettier 228" src="https://img.shields.io/badge/prettier-228-F7B93E?logo=prettier&logoColor=black"></a>
</p>

# Mauria API

A Fastify gateway between the [Mauria app](https://github.com/MauriaApp/Webapp) and [Junia](https://www.junia.com) services: [Aurion](https://aurion.junia.com) grades, planning, absences and documents, [CROUS](https://croustillant.menu) and [Lacatho](https://all-lacatho.fr/fr/menu-jour) menus, [FindMyRoom](https://findmyroom.junia.com), [Junia print](https://print.junia.com/end-user/ui), [Supabase](https://supabase.com) content and Palantir search. Inputs are checked against JSON schemas, with no type coercion. Each user's reads stay warm in memory, so a repeat planning read drops from 5 s to 3 ms. Slow first reads stream step by step. Server errors go to [Sentry](https://sentry.io) without user info, cookies, headers or request bodies, and secrets are scrubbed before sending. It runs on one 256 MB machine on Fly.io.

<table>
<tr><td>

https://github.com/user-attachments/assets/dc9d5532-8830-4522-abeb-e613817bd70d

</td></tr>
</table>

Each coloured band is one flow. On GitHub, use the diagram's pan and zoom controls to read the details.

```mermaid
---
config:
  sequence:
    mirrorActors: true
---
sequenceDiagram
  box Client
    actor U as App
  end
  box API
    participant R@{ "type": "control" } as Fastify<br/>routes
    participant M@{ "type": "entity" } as Aurion session<br/>jar, seal, inflight
    participant C@{ "type": "database" } as withCache<br/>HIT, STALE, MISS
  end
  box Harvester
    participant H@{ "type": "control" } as Palantir daemon<br/>separate process
  end
  box Upstream
    participant P@{ "type": "collections" } as CROUS, Lacatho<br/>FindMyRoom<br/>status
    participant D@{ "type": "database" } as Supabase<br/>PostgREST
    participant S@{ "type": "boundary" } as Aurion
    participant J@{ "type": "boundary" } as Junia print
  end
  autonumber

  rect rgba(74,222,128,0.10)
    Note over R,D: Boot, index load, then Promise.allSettled
    R->>D: palantir_index, latest row, before listen, 15 s max
    R->>P: CROUS /menu, else /menu/dd-mm-yyyy
    R->>P: Lacatho PDF, FindMyRoom buildings, BadJunia status
    R->>D: associations, messages, tools, updates, colles
    R->>()C: toDailyMenu {date, restaurants[]}, rows
    Note over C: CROUS 30 min, never past Paris midnight<br/>Supabase 30 min or Paris day, updates 24 h, colles 6 h<br/>FindMyRoom 20 s, dropped after 10 min
  end

  rect rgba(167,139,250,0.10)
    Note over U,D: Public and Supabase read
    U->>+R: GET /crous/:code/menu, /messages
    R<<->>C: withCache(key), joins a fetch in flight
    opt MISS, or STALE refresh behind
      R->>D: select (PostgREST)
    end
    R-->>-U: 200 data, X-Cache, Age, swr=60
  end

  rect rgba(96,165,250,0.10)
    Note over U,J: Print, /print/*
    U->>+R: POST /print/jobs, balance, delete {email, password}
    opt no print session for this credential (10 min sliding)
      R->>J: GET /login _csrf, POST j_spring_security_check
    end
    R<<->>C: jobs, balance 15 s
    R->>J: list, balance, delete, upload (multipart, 100 MiB)
    R-->>-U: 200, delete or upload drops cached jobs and balance
  end

  rect rgba(232,121,249,0.10)
    Note over U,R: Guards
    U->>R: POST {email, password}, x-aurion-session?
    break schema or size fails
      R-->>U: 400 invalid, 413 over 64 KiB
    end
  end

  rect rgba(251,146,60,0.10)
    Note over U,S: Login, POST /aurion/login
    U->>+R: {email, password}
    R->>+M: session.login
    alt warm slot alive (per credential, 25 min sliding)
      M-->>R: reuse jar, one home GET check
    else cold
      M->>S: POST /login, 302 and cookie
      S-->>M: refused: dropWarm, 401 Identifiants invalides
    end
    M-->>-R: jar
    R-->>-U: 200, x-aurion-session<br/>AES-256-GCM {flow, jar, nav, home, exp 2 h}
    par maintainWarm, unless the user is walking
      M->>S: home, then grades, planning, absences, documents, 2 lanes
      M->>()C: aurion-grades:warm, entry:warm:flow, menuRegistry 30 min
    end
  end

  rect rgba(34,211,238,0.10)
    Note over U,C: Warm read
    U->>+R: POST /aurion/grades {email, password}, token
    R<<->>C: cacheStateOf, before the run
    R-->>-U: 200 {success, data}, X-Cache HIT, 0 Aurion calls
  end

  rect rgba(45,212,191,0.10)
    Note over U,S: Cold 2nd
    U->>+R: next screen, or next user
    R->>+M: inflight(walk:key), identical requests share one run
    M->>S: jar known, home 5 s cache: unfold, leaf, table POSTs
    M->>S: entry prebuilt: table POST only
    M-->>-R: rows
    R-->>-U: 200 {success, data}
  end

  rect rgba(248,113,113,0.10)
    Note over U,S: Cold 1st, x-aurion-stream 1
    U->>+R: POST /aurion/grades, x-aurion-demand header|selector|all
    R-->>U: NDJSON start
    R->>+M: walk(demand)
    M->>S: POST /login, GET / (viewState, menu ids)
    M->>S: unfold, leaf (else GET ChoixIndividu), table rows=2001
    S-->>M: HTML, PageParser.parseGrades, noRows guard
    M-->>U: step, partial, leaf|leaf-error, result, done
    M-->>-R: data
    R-->>-U: {success, data}, X-Cache MISS, no-store
  end

  rect rgba(129,140,248,0.10)
    Note over U,S: Palantir, index built outside the API
    H->>S: harvest plannings with a service account, 400 ms pace
    H->>R: POST /palantir/publish, x-palantir-token, up to 25 MiB
    break token wrong, checked before the body is read
      R-->>H: 401
    end
    R->>D: insert palantir_index, keep the last versions
    U->>+R: POST /palantir/search, planning
    opt group has no lessons in the index
      R->>S: live planning walk
    end
    R-->>-U: 200 {success, data, status}, people and teacher for palantir_admins only, else 404
  end

  rect rgba(250,204,21,0.10)
    Note over U,S: Hard states
    critical assertLive on every Aurion call
      S-->>M: page
    option 302 /login, Se connecter, ViewExpired
      M->>S: lostSession: drop slot, one forced login, one retry
    option token dead, or slot gone
      R-->>U: X-Session-State expired|stale, re-login from body
    option Aurion or Supabase fails
      R-->>U: 500 Erreur amont, Retry-After 5<br/>502 Supabase, 504 documents over 60 s
      create participant E@{ "type": "queue" } as Sentry<br/>if SENTRY_DSN
      R-)E: captureFailure {route, id, status}, request dropped, no PII<br/>4xx not sent, 1 event per issue per minute, SDK loaded on first error
    end
    loop every 60 s
      R->>S: anonymous GET / ping
      M<<->>S: maintainWarm, keys used under 12 h, 64 most recent
      Note over M,S: skipped while 16+ upstream requests are in flight
    end
  end
```

| Step | Command | Notes |
| --- | --- | --- |
| Configure | <pre lang="sh">cp .env.example .env</pre> | fill `SUPABASE_URL`, `SUPABASE_KEY`, `SUPABASE_SERVICE_KEY` (see [`.env.example`](.env.example); `.env.dev` for `dev`) |
| Install | <pre lang="sh">npm ci</pre> | Node 26 in `.nvmrc` (22.13+ supported) |
| Develop | <pre lang="sh">npm run dev</pre> | reloads on save, needs [Bun](https://bun.sh), reads `.env.dev` |
| Typecheck | <pre lang="sh">npm run typecheck</pre> | |
| Build & test | <pre lang="sh">npm test</pre> | builds `dist/` and runs all 753 tests |
| Serve | <pre lang="sh">npm start</pre> | port 8080, docs at `/docs`, 160 MiB heap |
| Container | <pre lang="sh">docker build --platform linux/amd64 -t mauria-api .&#10;docker run --env-file .env -p 8080:8080 mauria-api</pre> | same 193 MB image as Fly |
| Harvester | <pre lang="sh">node dist/palantir-daemon.js</pre> | systemd unit in [`scripts/palantir-harvest.service`](scripts/palantir-harvest.service) |
| Deploy | <pre lang="sh">fly secrets set SUPABASE_URL=... SUPABASE_KEY=... SUPABASE_SERVICE_KEY=... --stage&#10;fly deploy --remote-only</pre> | CI deploys every push to `main` with the tested image |
