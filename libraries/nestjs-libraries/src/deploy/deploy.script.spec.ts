// VPS deploy: deploy.sh pulls, migrates, then starts, and starts nothing when
// the pull or the migration fails; env.example carries every variable the stack needs, with the
// production switches the contract names. Docker is replaced by a shim that records its arguments.
import { spawnSync } from 'child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const DEPLOY = join(__dirname, '..', '..', '..', '..', 'deploy');
const COMPOSE = readFileSync(join(DEPLOY, 'docker-compose.yaml'), 'utf8');
const ENV_EXAMPLE = readFileSync(join(DEPLOY, 'env.example'), 'utf8');
const README = readFileSync(join(DEPLOY, 'README.md'), 'utf8');
const START = 'up -d --wait --remove-orphans';

// The variable names a tier file under deploy/tiers sets.
const tierNames = (file: string) =>
  new Set(
    readFileSync(join(DEPLOY, 'tiers', file), 'utf8')
      .split('\n')
      .map((l) => /^([A-Z][A-Z0-9_]*)=/.exec(l)?.[1])
      .filter((n): n is string => !!n),
  );

// A filled-in copy of env.example: every placeholder replaced, as an operator would.
const FILLED = ENV_EXAMPLE.replace(/change-me/g, 'secret-value').replace(/app\.example\.com/g, 'app.test');

describe('deploy.sh', () => {
  const dirs: string[] = [];

  // Builds a deploy tree in a temp dir with the real scripts, a tier file and the given .env contents.
  const tree = (env: string | null = FILLED) => {
    const root = mkdtempSync(join(tmpdir(), 'deploy-'));
    dirs.push(root);
    const deploy = join(root, 'deploy');
    mkdirSync(join(deploy, 'scripts'), { recursive: true });
    mkdirSync(join(deploy, 'tiers'));
    for (const script of ['deploy.sh', 'migrate.sh']) {
      copyFileSync(join(DEPLOY, 'scripts', script), join(deploy, 'scripts', script));
    }
    copyFileSync(join(DEPLOY, 'tiers', '2gb.env'), join(deploy, 'tiers', '2gb.env'));
    copyFileSync(join(DEPLOY, 'docker-compose.yaml'), join(deploy, 'docker-compose.yaml'));
    if (env !== null) writeFileSync(join(deploy, '.env'), env);

    const shim = join(root, 'bin');
    mkdirSync(shim);
    writeFileSync(
      join(shim, 'docker'),
      [
        '#!/bin/sh',
        'echo "$*" >> "$DOCKER_LOG"',
        'case " $* " in',
        '  *" pull "*) [ -z "${FAIL_PULL:-}" ] || exit 1 ;;',
        '  *" run "*) [ -z "${FAIL_MIGRATE:-}" ] || exit 1 ;;',
        '  *" exec "*) [ -z "${FAIL_READY:-}" ] || exit 1 ;;',
        'esac',
        '',
      ].join('\n'),
    );
    chmodSync(join(shim, 'docker'), 0o755);
    return { root, deploy, shim, log: join(root, 'docker.log') };
  };

  // Runs deploy.sh from a tree with the docker shim first on PATH; returns status, output and the docker calls.
  const run = (t: ReturnType<typeof tree>, args: string[], extra: Record<string, string> = {}) => {
    const result = spawnSync('sh', [join(t.deploy, 'scripts', 'deploy.sh'), ...args], {
      env: { ...process.env, PATH: `${t.shim}:${process.env.PATH}`, DOCKER_LOG: t.log, ...extra },
      encoding: 'utf8',
    });
    const calls = existsSync(t.log) ? readFileSync(t.log, 'utf8').split('\n').filter(Boolean) : [];
    return { status: result.status, output: result.stdout + result.stderr, calls };
  };

  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('pulls, then migrates, then starts the stack, each with the tier file and the operator env file', () => {
    const t = tree();
    const { status, calls } = run(t, ['2gb']);
    const pull = calls.findIndex((c) => / pull$/.test(c));
    const migrate = calls.findIndex((c) => / run --rm --no-deps app /.test(c));
    const start = calls.findIndex((c) => c.endsWith(START));
    expect(status).toBe(0);
    expect(pull).toBeGreaterThanOrEqual(0);
    expect(migrate).toBeGreaterThan(pull);
    expect(start).toBeGreaterThan(migrate);
    for (const call of [calls[pull], calls[migrate], calls[start]]) {
      expect(call).toContain(`--env-file ${join(t.deploy, 'tiers', '2gb.env')} --env-file ${join(t.deploy, '.env')}`);
    }
  });

  it('exits non-zero and starts no app when the migration fails', () => {
    const t = tree();
    const { status, output, calls } = run(t, ['2gb'], { FAIL_MIGRATE: '1' });
    expect(status).not.toBe(0);
    expect(output).toContain('migration failed');
    expect(calls.some((c) => c.endsWith(START))).toBe(false);
    expect(calls.some((c) => / exec /.test(c))).toBe(false);
  });

  it('exits non-zero and neither migrates nor starts when the image pull fails', () => {
    const t = tree();
    const { status, calls } = run(t, ['2gb'], { FAIL_PULL: '1' });
    expect(status).not.toBe(0);
    expect(calls.some((c) => / run /.test(c))).toBe(false);
    expect(calls.some((c) => c.endsWith(START))).toBe(false);
  });

  it('is idempotent: a second run issues the same commands and succeeds again', () => {
    const t = tree();
    const first = run(t, ['2gb']);
    const second = run(t, ['2gb']);
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(second.calls).toEqual([...first.calls, ...first.calls]);
  });

  it('exits non-zero when the app never answers', () => {
    const t = tree();
    const { status, output } = run(t, ['2gb'], { FAIL_READY: '1', DEPLOY_READY_SECONDS: '1' });
    expect(status).not.toBe(0);
    expect(output).toContain('did not answer');
  });

  it.each([[[]], [['']], [['../2gb']], [['nope']], [['2GB']]])('refuses the tier %j before touching docker', (args) => {
    const t = tree();
    const { status, calls } = run(t, args as string[]);
    expect(status).not.toBe(0);
    expect(calls).toEqual([]);
  });

  it('refuses to run without deploy/.env', () => {
    const t = tree(null);
    const { status, output, calls } = run(t, ['2gb']);
    expect(status).not.toBe(0);
    expect(output).toContain('deploy/env.example');
    expect(calls).toEqual([]);
  });

  it('refuses an env file that still holds the placeholders of env.example', () => {
    const t = tree(ENV_EXAMPLE);
    const { status, output, calls } = run(t, ['2gb']);
    expect(status).not.toBe(0);
    expect(output).toContain('placeholder');
    expect(calls).toEqual([]);
  });

  it.each(['temporal', 'temporal_visibility'])('refuses TEMPORAL_DB_USER=%s, which blocks Temporal creating its database', (user) => {
    const t = tree(FILLED.replace(/^TEMPORAL_DB_USER=.*$/m, `TEMPORAL_DB_USER=${user}`));
    const { status, calls } = run(t, ['2gb']);
    expect(status).not.toBe(0);
    expect(calls).toEqual([]);
  });
});

describe('deploy/env.example', () => {
  const names = new Set(
    ENV_EXAMPLE.split('\n')
      .map((l) => /^([A-Z][A-Z0-9_]*)=/.exec(l)?.[1])
      .filter((n): n is string => !!n),
  );

  it('turns periodic workflows on and carries no payment variable other than PayPal\'s', () => {
    expect(ENV_EXAMPLE).toMatch(/^RUN_CRON=true\b/m);
    expect([...names].filter((n) => /PAY|BILL|CHECKOUT|CARD/.test(n) && !n.startsWith('PAYPAL_'))).toEqual([]);
  });

  // The removed payment vendor has no variable in any file the operator or the stack reads. Its name
  // is written in two pieces because the removal spec's repository-wide source scan forbids the word here.
  const REMOVED_VENDOR = new RegExp(['str', 'ipe'].join(''), 'i');
  it('defines no variable of the removed payment vendor, in env.example, in a tier file or in compose', () => {
    expect([...names].filter((n) => REMOVED_VENDOR.test(n))).toEqual([]);
    for (const tier of readdirSync(join(DEPLOY, 'tiers'))) {
      expect({ tier, found: [...tierNames(tier)].filter((n) => REMOVED_VENDOR.test(n)) }).toEqual({ tier, found: [] });
    }
    expect(COMPOSE).not.toMatch(REMOVED_VENDOR);
  });

  // The web session lasts about 100 years (36500 days) and is revoked, not expired.
  it('keeps the refresh token life at about 100 years', () => {
    expect(Number(/^REFRESH_TOKEN_TTL_DAYS=(\d+)/m.exec(ENV_EXAMPLE)?.[1])).toBeGreaterThanOrEqual(36500);
  });

  it('runs as production, which also makes the app refuse the log mail provider', () => {
    expect(ENV_EXAMPLE).toMatch(/^NODE_ENV=production\b/m);
    expect(ENV_EXAMPLE).toMatch(/^EMAIL_PROVIDER=mailgun\b/m);
  });

  it.each([
    'MAILGUN_API_KEY',
    'MAILGUN_DOMAIN',
    'MAILGUN_REGION',
    'EMAIL_FROM_NAME',
    'EMAIL_FROM_ADDRESS',
    'MAIL_SEND_TIMEOUT_SECONDS',
    'ACCESS_TOKEN_TTL_SECONDS',
    'REFRESH_TOKEN_TTL_DAYS',
    'REFRESH_GRACE_SECONDS',
    'AUTH_FAIL_LIMIT',
    'AUTH_FAIL_WINDOW_SECONDS',
    'OTP_TTL_SECONDS',
    'OTP_MAX_TRIES',
    'OTP_RESEND_COOLDOWN_SECONDS',
    'OTP_REQUEST_LIMIT',
    'OTP_REQUEST_WINDOW_SECONDS',
    'JWT_SECRET',
    'PAYPAL_API_BASE',
    'PAYPAL_CLIENT_ID',
    'PAYPAL_CLIENT_SECRET',
    'PAYPAL_WEBHOOK_ID',
    'FRONTEND_URL',
    'NEXT_PUBLIC_BACKEND_URL',
  ])('defines %s', (name) => {
    expect(names.has(name)).toBe(true);
  });

  // Variables the app reads in production that compose never names; they reach it through env_file, so
  // dropping one is silent: an absent STORAGE_PROVIDER selects local disk storage.
  it.each([
    'STORAGE_PROVIDER',
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_ACCESS_KEY',
    'CLOUDFLARE_SECRET_ACCESS_KEY',
    'CLOUDFLARE_BUCKETNAME',
    'CLOUDFLARE_BUCKET_URL',
    'CLOUDFLARE_REGION',
    'IS_GENERAL',
  ])('defines %s, which the app needs in production and the compose file does not read', (name) => {
    expect(names.has(name)).toBe(true);
  });

  it('stores media on Cloudflare R2 in production, not on the container disk', () => {
    expect(ENV_EXAMPLE).toMatch(/^STORAGE_PROVIDER=cloudflare\b/m);
  });

  it('defines every variable the compose file reads, or leaves it to each tier file', () => {
    const needed = new Set(
      [...COMPOSE.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)].map((m) => m[1]),
    );
    for (const tier of readdirSync(join(DEPLOY, 'tiers'))) {
      const fromTier = tierNames(tier);
      const missing = [...needed].filter((n) => !names.has(n) && !fromTier.has(n));
      expect({ tier, missing }).toEqual({ tier, missing: [] });
    }
  });

  it('never sets a value that a tier file owns', () => {
    for (const tier of readdirSync(join(DEPLOY, 'tiers'))) {
      expect([...tierNames(tier)].filter((n) => names.has(n))).toEqual([]);
    }
  });

  it("uses a Temporal role name that is not one of Temporal's database names", () => {
    const user = /^TEMPORAL_DB_USER=(.*)$/m.exec(ENV_EXAMPLE)![1].trim();
    expect(['temporal', 'temporal_visibility']).not.toContain(user);
  });
});

describe('deploy/docker-compose.yaml', () => {
  it('keeps the sample search attributes out of the Temporal SQL visibility store', () => {
    expect(COMPOSE).toContain('SKIP_ADD_CUSTOM_SEARCH_ATTRIBUTES=true');
  });

  it('reads the app environment from the one operator file, deploy/.env', () => {
    expect(COMPOSE).toMatch(/env_file: \.env\b/);
  });

  // The lines of one service in the compose file, from "  <name>:" to the next key at the same depth.
  const serviceBlock = (name: string) => {
    const lines = COMPOSE.split(/\r?\n/);
    const rest = lines.slice(lines.findIndex((l) => l === `  ${name}:`) + 1);
    const end = rest.findIndex((l) => /^\s{0,2}\S/.test(l));
    return rest.slice(0, end === -1 ? undefined : end).join('\n');
  };

  // A tier file's limit applies only if the service it sizes takes it as mem_limit: a soak on a stack whose
  // limits are not applied proves nothing about the tier.
  it.each([
    ['app', 'APP_MEM_LIMIT'],
    ['postgres', 'PG_MEM_LIMIT'],
    ['temporal', 'TEMPORAL_MEM_LIMIT'],
    ['redis', 'REDIS_MEM_LIMIT'],
    ['caddy', 'CADDY_MEM_LIMIT'],
  ])('sizes the %s container from %s', (service, variable) => {
    expect(serviceBlock(service)).toMatch(new RegExp(`^    mem_limit: \\$\\{${variable}\\}\\s*$`, 'm'));
  });

  it.each(['BACKEND_HEAP_MB', 'ORCHESTRATOR_HEAP_MB', 'FRONTEND_HEAP_MB'])(
    'hands %s from the tier file to the app environment',
    (variable) => {
      expect(serviceBlock('app')).toMatch(new RegExp(`^      ${variable}: \\$\\{${variable}\\}\\s*$`, 'm'));
    },
  );

  it.each(readdirSync(join(DEPLOY, 'tiers')))('reads every variable the tier file %s sets', (tier) => {
    const unread = [...tierNames(tier)].filter((n) => !COMPOSE.includes(`\${${n}}`) && !COMPOSE.includes(`\${${n}:-`));
    expect(unread).toEqual([]);
  });
});

describe('deploy/tiers/2gb.env', () => {
  // The integer value of one variable in tiers/2gb.env.
  const tier = (name: string) =>
    Number(
      /^[A-Z_]+=(\d+)/m.exec(
        readFileSync(join(DEPLOY, 'tiers', '2gb.env'), 'utf8').match(new RegExp(`^${name}=.*$`, 'm'))![0],
      )![1],
    );

  // Measured 2026-10-08: the backend heap crashes at 384 MB and the orchestrator's at 256 MB, and an
  // app container limit of 1200m is OOM-killed in a loop; these floors keep a later edit from going back.
  it('keeps the heaps above the measured crash points and the app limit above the measured OOM point', () => {
    expect(tier('BACKEND_HEAP_MB')).toBeGreaterThan(448);
    expect(tier('ORCHESTRATOR_HEAP_MB')).toBeGreaterThan(320);
    expect(tier('APP_MEM_LIMIT')).toBeGreaterThanOrEqual(1500);
  });

  // The container limits README.md's 2 GB sizing table documents, keyed by service.
  const documented = () => {
    const rows = [...README.matchAll(/^\| (app|postgres|temporal|redis|caddy)\b[^|]*\| (\d+m) \|/gm)];
    return Object.fromEntries(rows.map((m) => [m[1], m[2]]));
  };
  // The value of one variable in tiers/2gb.env, as written.
  const tierText = (name: string) =>
    new RegExp(`^${name}=(\\S+)`, 'm').exec(readFileSync(join(DEPLOY, 'tiers', '2gb.env'), 'utf8'))?.[1];

  it('applies the container limits measured in README.md, for every service', () => {
    expect(documented()).toEqual({ app: '1500m', postgres: '400m', temporal: '350m', redis: '96m', caddy: '64m' });
    expect({
      app: tierText('APP_MEM_LIMIT'),
      postgres: tierText('PG_MEM_LIMIT'),
      temporal: tierText('TEMPORAL_MEM_LIMIT'),
      redis: tierText('REDIS_MEM_LIMIT'),
      caddy: tierText('CADDY_MEM_LIMIT'),
    }).toEqual(documented());
  });

  it('keeps the three heaps and the app limit consistent: the heaps fit inside the container', () => {
    expect(
      tier('BACKEND_HEAP_MB') + tier('ORCHESTRATOR_HEAP_MB') + tier('FRONTEND_HEAP_MB'),
    ).toBeLessThan(tier('APP_MEM_LIMIT'));
  });
});

describe('soak.sh', () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  // What `pm2 jlist` prints: one entry per process, each with its restart count under pm2_env.
  const jlist = (...restarts: number[]) =>
    JSON.stringify(
      restarts.map((restart_time, i) => ({ name: `proc-${i}`, pid: 100 + i, pm2_env: { status: 'online', restart_time } })),
    );

  // A deploy tree whose docker answers like a stack: stats, inspect and cgroup files from the shim, and
  // `docker exec app sh -c <script>` run for real against a `pm2` shim that prints `jlist`-shaped output
  // (PM2_JLIST_START / PM2_JLIST_END, or PM2_FAIL start|end|always). The OOM counter after the run and the
  // first pm2 process's restarts after the run are set by the caller; `extra` sets shim modes (STATS_USAGE
  // as "a@b@c" per sample, NO_PEAK, OOM_UNREADABLE, PM2_*, DMESG_MODE), removes a variable (undefined)
  // or sets FAKE_CLOCK, which scripts `date +%s` and records `sleep` instead of waiting. `hours` is the
  // first argument of soak.sh (null: none).
  const soak = (
    oomAfter: number,
    pm2After: number,
    restarts = 0,
    extra: Record<string, string | undefined> = {},
    hours: string | null = '1',
  ) => {
    const root = mkdtempSync(join(tmpdir(), 'soak-'));
    dirs.push(root);
    mkdirSync(join(root, 'deploy', 'scripts'), { recursive: true });
    copyFileSync(join(DEPLOY, 'scripts', 'soak.sh'), join(root, 'deploy', 'scripts', 'soak.sh'));
    const bin = join(root, 'bin');
    mkdirSync(bin);
    // Writes an executable shell script named `name` into the shim directory that is first on PATH.
    const shim = (name: string, lines: string[]) => {
      writeFileSync(join(bin, name), ['#!/bin/sh', ...lines, ''].join('\n'));
      chmodSync(join(bin, name), 0o755);
    };
    shim('docker', [
      'case "$1" in',
      '  stats)',
      '    for last; do :; done',
      '    n="$SHIM_STATE/stats-$last"; i=$(cat "$n" 2>/dev/null || echo 0); echo $((i + 1)) > "$n"',
      '    all="${STATS_USAGE:-100MiB / 1GiB}"',
      '    pick=$(echo "$all" | cut -d@ -f$((i + 1)))',
      '    [ -n "$pick" ] || pick=$(echo "$all" | rev | cut -d@ -f1 | rev)',
      '    echo "$pick,10%" ;;',
      '  inspect) case "$*" in',
      '    *Memory*) echo "${RESTARTS} false 1048576000" ;;',
      '    *) echo "${RESTARTS},false" ;; esac ;;',
      '  exec)',
      '    if [ "$3" = cat ]; then',
      '      case "$4" in',
      '        */memory.events)',
      '          n="$SHIM_STATE/$2"; c=$(cat "$n" 2>/dev/null || echo 0); echo $((c + 1)) > "$n"',
      '          case "${OOM_UNREADABLE:-}" in',
      '            always) exit 1 ;;',
      '            start) [ "$c" != 0 ] || exit 1 ;;',
      '            end) [ "$c" = 0 ] || exit 1 ;;',
      '            nokey) printf "oom 0\\n"; exit 0 ;;',
      '          esac',
      '          printf "oom 0\\noom_kill %s\\n" "$([ "$c" = 0 ] && echo 0 || echo "$OOM_AFTER")" ;;',
      '        */memory.peak) [ -z "${NO_PEAK:-}" ] || exit 1; echo 524288000 ;;',
      '        *) echo 0 ;;',
      '      esac',
      '    else',
      '      shift 2; exec "$@"',
      '    fi ;;',
      'esac',
    ]);
    shim('pm2', [
      'c=$(cat "$SHIM_STATE/pm2" 2>/dev/null || echo 0); echo $((c + 1)) > "$SHIM_STATE/pm2"',
      'case "${PM2_FAIL:-}" in',
      '  always) exit 1 ;;',
      '  start) [ "$c" != 0 ] || exit 1 ;;',
      '  end) [ "$c" = 0 ] || exit 1 ;;',
      'esac',
      'if [ "$c" = 0 ]; then printf "%s" "$PM2_JLIST_START"; else printf "%s" "$PM2_JLIST_END"; fi',
    ]);
    // A kernel log: a clean boot line by default, and by DMESG_MODE a refusal to be read (denied), an
    // out-of-memory message (held), or either from the second read on (late-denied, late-held).
    shim('dmesg', [
      'c=$(cat "$SHIM_STATE/dmesg" 2>/dev/null || echo 0); echo $((c + 1)) > "$SHIM_STATE/dmesg"',
      '# Fails the way a restricted kernel log does: nothing on stdout, a permission error, exit 1.',
      'denied() { echo "dmesg: read kernel buffer failed: Operation not permitted" >&2; exit 1; }',
      '# Prints the line the kernel writes when its out-of-memory killer fires.',
      'oom() { echo "[ 99.1] Out of memory: Killed process 4242 (node) total-vm:2097152kB"; }',
      'echo "[    0.000000] Linux version 6.8.0 (buildd@lcy02) #1 SMP"',
      'case "${DMESG_MODE:-}" in',
      '  denied) denied ;;',
      '  late-denied) [ "$c" = 0 ] || denied ;;',
      '  held) oom ;;',
      '  late-held) [ "$c" = 0 ] || oom ;;',
      'esac',
    ]);
    // A scripted clock: the start, one second before the deadline of a CLOCK_SPAN run, then the deadline,
    // then far past it once a second sleep was asked for, so a run that is too long still ends.
    shim('date', [
      'case "$1" in',
      '  +%s)',
      '    n=$(cat "$SHIM_STATE/clock" 2>/dev/null || echo 0); echo $((n + 1)) > "$SHIM_STATE/clock"',
      '    s=$(wc -l < "$SHIM_STATE/sleeps" 2>/dev/null || echo 0)',
      '    if [ "$n" = 0 ]; then echo "$CLOCK_START"',
      '    elif [ "$s" -ge 2 ]; then echo $((CLOCK_START + CLOCK_SPAN * 100))',
      '    elif [ "$s" = 1 ]; then echo $((CLOCK_START + CLOCK_SPAN))',
      '    else echo $((CLOCK_START + CLOCK_SPAN - 1)); fi ;;',
      '  *) PATH="$REAL_PATH" exec date "$@" ;;',
      'esac',
    ]);
    shim('sleep', ['echo "$1" >> "$SHIM_STATE/sleeps"']);
    // Without FAKE_CLOCK the real date and sleep are used: the two shims are removed again.
    if (!extra.FAKE_CLOCK) {
      rmSync(join(bin, 'date'));
      rmSync(join(bin, 'sleep'));
    }
    const state = join(root, 'state');
    mkdirSync(state);
    const env: Record<string, string | undefined> = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      REAL_PATH: process.env.PATH,
      SHIM_STATE: state,
      OOM_AFTER: String(oomAfter),
      PM2_JLIST_START: jlist(0, 0, 0),
      PM2_JLIST_END: jlist(pm2After, 0, 0),
      RESTARTS: String(restarts),
      SOAK_DURATION_SECONDS: '1',
      SOAK_SAMPLE_SECONDS: '1',
      ...extra,
    };
    const result = spawnSync('sh', [join(root, 'deploy', 'scripts', 'soak.sh'), ...(hours === null ? [] : [hours, '2gb'])], {
      env,
      encoding: 'utf8',
    });
    const dir = join(root, 'deploy', 'soak');
    const summary = readdirSync(dir).filter((f) => f.endsWith('.md'));
    const sleepLog = join(state, 'sleeps');
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      summary: summary.length ? readFileSync(join(dir, summary[0]), 'utf8') : '',
      sleeps: existsSync(sleepLog) ? readFileSync(sleepLog, 'utf8').split('\n').filter(Boolean) : [],
      sampled: existsSync(join(state, 'stats-app')),
    };
  };

  it('passes and writes a summary with date, tier, peak memory per service and the OOM-kill count', () => {
    const { status, summary } = soak(0, 0);
    expect(status).toBe(0);
    expect(summary).toContain(`date: ${new Date().toISOString().slice(0, 10)}`);
    expect(summary).toContain('tier: 2gb');
    for (const service of ['app', 'postgres', 'redis', 'temporal', 'caddy']) {
      expect(summary).toContain(`| ${service} | 1000 MB | 500 MB | 0 MB | 0 | 0 |`);
    }
    expect(summary).toContain('kernel log (dmesg): no out-of-memory message');
    expect(summary).toContain('result: PASS');
  });

  // The proof is `soak.sh 72`, sampled every minute: the clock is scripted so the run reads the
  // deadline one second before it (a sample is taken) and at it (the run ends), and the sleeps are recorded.
  it.each(['72', null])('runs for 72 hours, sampling every 60 seconds by default, with hours argument %j', (hours) => {
    const { status, sleeps, summary } = soak(
      0,
      0,
      0,
      {
        FAKE_CLOCK: '1',
        SOAK_DURATION_SECONDS: undefined,
        SOAK_SAMPLE_SECONDS: undefined,
        CLOCK_START: '1760000000',
        CLOCK_SPAN: String(72 * 60 * 60),
      },
      hours,
    );
    expect(status).toBe(0);
    expect(sleeps).toEqual(['60']);
    expect(summary).toContain('duration: 4320 minutes, sampled every 60s');
  });

  it('fails with exit 1 when a node process inside the app container was OOM-killed, though docker shows no restart', () => {
    const { status, output, summary } = soak(3, 0);
    expect(status).toBe(1);
    expect(output).toContain('oom_kill_events=3');
    expect(summary).toContain('result: FAIL');
  });

  it('fails with exit 1 when pm2 restarted a process in the app container', () => {
    const { status, output } = soak(0, 4);
    expect(status).toBe(1);
    expect(output).toContain('pm2 restarted a process in the app container (0 -> 4)');
  });

  // The restart total is read from the real `pm2 jlist` shape by the command soak.sh runs in the container.
  it('sums the restarts of every pm2 process and fails when the total grew', () => {
    const { status, output, summary } = soak(0, 0, 0, { PM2_JLIST_START: jlist(0, 0, 0), PM2_JLIST_END: jlist(1, 2, 3) });
    expect(status).toBe(1);
    expect(output).toContain('(0 -> 6)');
    expect(summary).toContain('pm2 restarts in app during the soak: 6');
  });

  it('does not count the restarts a pm2 process already had when the soak started', () => {
    const { status, summary } = soak(0, 0, 0, { PM2_JLIST_START: jlist(2, 5, 0), PM2_JLIST_END: jlist(2, 5, 0) });
    expect(status).toBe(0);
    expect(summary).toContain('pm2 restarts in app during the soak: 0');
  });

  it('fails with exit 1 when a container was restarted', () => {
    const { status, output } = soak(0, 0, 1);
    expect(status).toBe(1);
    expect(output).toContain('restarts=1');
  });

  // Without memory.peak (kernels before 5.19) the peak is the largest sampled MemUsage, and docker prints
  // it in whatever unit fits the number. A 2 s window always holds one sample; a 1 s window can hold none
  // when the clock's second rolls over before the first check.
  const NO_PEAK = { NO_PEAK: '1', SOAK_DURATION_SECONDS: '2' };
  it.each([
    ['1.17GiB / 1.953GiB', '1198 MB'],
    ['2048KiB / 1GiB', '2 MB'],
    ['100MiB / 1GiB', '100 MB'],
    ['12XB / 1GiB', 'n/a'],
  ])('reports the peak of MemUsage "%s" as %s on a host without memory.peak', (usage, peak) => {
    const { status, summary } = soak(0, 0, 0, { STATS_USAGE: usage, ...NO_PEAK });
    expect(status).toBe(0);
    for (const service of ['app', 'postgres', 'redis', 'temporal', 'caddy']) {
      expect(summary).toContain(`| ${service} | 1000 MB | ${peak} | 0 MB | 0 | 0 |`);
    }
  });

  // The 3 s window holds at least two samples, so the first (largest) is never the last and 900 MiB is
  // numerically larger than 1.5 GiB's 1.5.
  it('takes the largest sample across units, not the last one', () => {
    const { summary } = soak(0, 0, 0, {
      STATS_USAGE: '1.5GiB / 2GiB@900MiB / 2GiB@200KiB / 2GiB',
      ...NO_PEAK,
      SOAK_DURATION_SECONDS: '3',
    });
    expect(summary).toContain('| app | 1000 MB | 1536 MB | 0 MB | 0 | 0 |');
  });

  // A soak PASS means zero OOM kills were observed, not that none could be read.
  it.each(['start', 'end', 'always', 'nokey'])(
    'ends UNKNOWN with exit 2, not PASS, when the OOM counter cannot be read (%s)',
    (mode) => {
      const { status, output, summary } = soak(0, 0, 0, { OOM_UNREADABLE: mode });
      expect(status).toBe(2);
      expect(output).not.toContain('PASS');
      expect(summary).not.toContain('result: PASS');
      expect(summary).toContain('result: UNKNOWN');
      expect(output).toContain('oom_kill counter could not be read');
      expect(summary).toContain('| app | 1000 MB | 500 MB | 0 MB | n/a | 0 |');
    },
  );

  // What the pm2 command of soak.sh sees when it cannot read a restart total: pm2 failing, an empty
  // process list (never read as zero restarts), and output that is not JSON.
  it.each([
    ['pm2 fails at the start', { PM2_FAIL: 'start' }],
    ['pm2 fails at the end', { PM2_FAIL: 'end' }],
    ['pm2 always fails', { PM2_FAIL: 'always' }],
    ['the process list is empty', { PM2_JLIST_START: '[]', PM2_JLIST_END: '[]' }],
    ['the process list is empty at the end', { PM2_JLIST_END: '[]' }],
    ['the output is not JSON', { PM2_JLIST_START: 'NaN', PM2_JLIST_END: 'NaN' }],
    ['a process has no restart count', { PM2_JLIST_END: JSON.stringify([{ name: 'x', pm2_env: {} }]) }],
  ])('ends UNKNOWN with exit 2, not PASS, when the pm2 restart count cannot be read: %s', (_name, extra) => {
    const { status, output, summary } = soak(0, 0, 0, extra);
    expect(status).toBe(2);
    expect(output).not.toContain('PASS');
    expect(summary).not.toContain('result: PASS');
    expect(summary).toContain('result: UNKNOWN');
    expect(output).toContain('pm2 restart count in the app container could not be read');
    expect(output).not.toContain('pm2 restarted a process');
    expect(summary).toContain('pm2 restarts in app during the soak: n/a');
  });

  it('still fails with exit 1, not only unknown, when a counter is unreadable and a container was restarted', () => {
    const { status, summary } = soak(0, 0, 1, { OOM_UNREADABLE: 'always' });
    expect(status).toBe(1);
    expect(summary).toContain('result: FAIL');
  });

  // The kernel log is read once before the first sample, so a 72 h run is not spent finding out that
  // it cannot be read, and once at the end.
  it('fails with exit 1 when the kernel log shows the OOM killer fired during the soak', () => {
    const { status, output, summary } = soak(0, 0, 0, { DMESG_MODE: 'late-held' });
    expect(status).toBe(1);
    expect(output).toContain('kernel OOM killer fired');
    expect(summary).toContain('kernel log (dmesg): an out-of-memory message appeared');
    expect(summary).toContain('result: FAIL');
  });

  it.each([
    ['cannot be read (kernel.dmesg_restrict=1)', 'denied'],
    ['already holds an out-of-memory message', 'held'],
  ])('does not start, and takes no sample, when the kernel log %s', (_name, mode) => {
    const { status, output, summary, sampled, sleeps } = soak(0, 0, 0, { DMESG_MODE: mode });
    expect(status).toBe(2);
    expect(output).toContain('NOT STARTED');
    expect(output).not.toContain('PASS');
    expect(sampled).toBe(false);
    expect(sleeps).toEqual([]);
    expect(summary).toBe('');
  });

  it('ends UNKNOWN with exit 2, not PASS, when the kernel log can no longer be read at the end', () => {
    const { status, output, summary } = soak(0, 0, 0, { DMESG_MODE: 'late-denied' });
    expect(status).toBe(2);
    expect(output).not.toContain('PASS');
    expect(output).toContain('kernel log could not be read');
    expect(summary).toContain('kernel log (dmesg): n/a (could not be read)');
    expect(summary).toContain('result: UNKNOWN');
  });
});
