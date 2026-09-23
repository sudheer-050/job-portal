'use strict';

const { normalizeQuery, rankJobs } = require('./core');
const { createBoardSources, createSearchSources } = require('./sources');

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 45;

function createJobService({ pool, env = process.env, logger = console } = {}) {
    if (!pool) throw new Error('A Postgres pool is required.');
    const ttlMs = Math.max(15 * 60 * 1000, Number(env.JOB_REFRESH_MINUTES || 360) * 60 * 1000) || DEFAULT_TTL_MS;
    const retentionDays = Math.max(7, Number(env.JOB_RETENTION_DAYS || DEFAULT_RETENTION_DAYS));
    const searchSources = createSearchSources(env).filter(source => source.enabled);
    const boardSources = createBoardSources(env);
    const activeRefreshes = new Map();
    let timer = null;

    async function ensureSchema() {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS job_postings (
                id TEXT PRIMARY KEY,
                source VARCHAR(40) NOT NULL,
                source_job_id TEXT NOT NULL,
                title TEXT NOT NULL,
                company TEXT,
                location TEXT,
                salary_min INTEGER,
                salary_max INTEGER,
                workplace_type VARCHAR(12) NOT NULL DEFAULT 'onsite',
                description TEXT,
                apply_url TEXT NOT NULL,
                canonical_key TEXT NOT NULL,
                posted_at TIMESTAMPTZ,
                first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                active BOOLEAN NOT NULL DEFAULT true,
                metadata JSONB NOT NULL DEFAULT '{}'::jsonb
            );
            CREATE INDEX IF NOT EXISTS job_postings_active_seen_idx ON job_postings (active, last_seen_at DESC);
            CREATE INDEX IF NOT EXISTS job_postings_source_idx ON job_postings (source);
            CREATE INDEX IF NOT EXISTS job_postings_posted_at_idx ON job_postings (posted_at DESC);

            CREATE TABLE IF NOT EXISTS job_search_results (
                role_query TEXT NOT NULL,
                location_query TEXT NOT NULL DEFAULT '',
                job_id TEXT NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
                fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                PRIMARY KEY (role_query, location_query, job_id)
            );
            CREATE INDEX IF NOT EXISTS job_search_results_query_idx
                ON job_search_results (role_query, location_query, fetched_at DESC);

            CREATE TABLE IF NOT EXISTS job_source_syncs (
                sync_key TEXT PRIMARY KEY,
                source VARCHAR(40) NOT NULL,
                status VARCHAR(12) NOT NULL,
                job_count INTEGER NOT NULL DEFAULT 0,
                error TEXT,
                started_at TIMESTAMPTZ NOT NULL,
                finished_at TIMESTAMPTZ NOT NULL
            );
        `);
    }

    async function upsertJob(client, job) {
        await client.query(
            `INSERT INTO job_postings
                (id, source, source_job_id, title, company, location, salary_min, salary_max, workplace_type,
                 description, apply_url, canonical_key, posted_at, last_seen_at, active, metadata)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now(),true,$14::jsonb)
             ON CONFLICT (id) DO UPDATE SET
                title=EXCLUDED.title, company=EXCLUDED.company, location=EXCLUDED.location,
                salary_min=EXCLUDED.salary_min, salary_max=EXCLUDED.salary_max,
                workplace_type=EXCLUDED.workplace_type, description=EXCLUDED.description,
                apply_url=EXCLUDED.apply_url, canonical_key=EXCLUDED.canonical_key,
                posted_at=COALESCE(EXCLUDED.posted_at, job_postings.posted_at),
                last_seen_at=now(), active=true, metadata=EXCLUDED.metadata`,
            [job.id, job.source, job.sourceId, job.title, job.company, job.location, job.salaryMin, job.salaryMax,
                job.workplaceType, job.description, job.applyUrl, job.canonicalKey, job.postedAt, JSON.stringify(job.metadata)]
        );
    }

    async function saveSearchResults(role, location, jobs) {
        const roleQuery = normalizeQuery(role);
        const locationQuery = normalizeQuery(location);
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            for (const job of jobs) {
                await upsertJob(client, job);
                await client.query(
                    `INSERT INTO job_search_results (role_query, location_query, job_id, fetched_at)
                     VALUES ($1,$2,$3,now())
                     ON CONFLICT (role_query, location_query, job_id) DO UPDATE SET fetched_at=now()`,
                    [roleQuery, locationQuery, job.id]
                );
            }
            await client.query(
                `DELETE FROM job_search_results
                 WHERE role_query=$1 AND location_query=$2 AND fetched_at < now() - ($3 * interval '1 day')`,
                [roleQuery, locationQuery, retentionDays]
            );
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    async function recordSync(syncKey, source, status, jobCount, error, startedAt) {
        await pool.query(
            `INSERT INTO job_source_syncs (sync_key, source, status, job_count, error, started_at, finished_at)
             VALUES ($1,$2,$3,$4,$5,$6,now())
             ON CONFLICT (sync_key) DO UPDATE SET source=$2,status=$3,job_count=$4,error=$5,started_at=$6,finished_at=now()`,
            [syncKey, source, status, jobCount, error ? String(error).slice(0, 1000) : null, startedAt]
        );
    }

    async function isFresh(syncKey) {
        const result = await pool.query('SELECT finished_at, status FROM job_source_syncs WHERE sync_key=$1', [syncKey]);
        const row = result.rows[0];
        return Boolean(row?.status === 'ok' && Date.now() - new Date(row.finished_at).getTime() < ttlMs);
    }

    function once(key, operation) {
        if (activeRefreshes.has(key)) return activeRefreshes.get(key);
        const promise = operation().finally(() => activeRefreshes.delete(key));
        activeRefreshes.set(key, promise);
        return promise;
    }

    async function refreshSearch(role, location = '', { force = false } = {}) {
        const roleQuery = normalizeQuery(role);
        const locationQuery = normalizeQuery(location);
        const key = `search:${roleQuery}:${locationQuery}`;
        return once(key, async () => {
            if (!force && await isFresh(key)) return { cached: true, count: 0 };
            const startedAt = new Date();
            const settled = await Promise.allSettled(searchSources.map(source => source.fetch(roleQuery, locationQuery)));
            const jobs = [];
            const errors = [];
            settled.forEach((result, index) => {
                if (result.status === 'fulfilled') jobs.push(...result.value);
                else {
                    errors.push(`${searchSources[index].name}: ${result.reason?.message || result.reason}`);
                    logger.warn(`Job source ${searchSources[index].name} failed:`, result.reason?.message || result.reason);
                }
            });
            await saveSearchResults(roleQuery, locationQuery, jobs);
            const status = jobs.length || errors.length < searchSources.length ? 'ok' : 'error';
            await recordSync(key, 'search', status, jobs.length, errors.join('; ') || null, startedAt);
            return { cached: false, count: jobs.length, errors };
        });
    }

    async function refreshBoard(source, target, { force = false } = {}) {
        const key = `board:${source.name}:${target.slug}`;
        return once(key, async () => {
            if (!force && await isFresh(key)) return { cached: true, count: 0 };
            const startedAt = new Date();
            try {
                const jobs = await source.fetch(target);
                const client = await pool.connect();
                try {
                    await client.query('BEGIN');
                    for (const job of jobs) await upsertJob(client, job);
                    await client.query(
                        `UPDATE job_postings SET active=false
                         WHERE source=$1 AND metadata->>'board'=$2 AND last_seen_at < $3`,
                        [source.name, target.slug, startedAt]
                    );
                    await client.query('COMMIT');
                } catch (error) {
                    await client.query('ROLLBACK');
                    throw error;
                } finally {
                    client.release();
                }
                await recordSync(key, source.name, 'ok', jobs.length, null, startedAt);
                return { source: source.name, target: target.slug, count: jobs.length };
            } catch (error) {
                await recordSync(key, source.name, 'error', 0, error.message, startedAt);
                logger.warn(`Job board ${source.name}/${target.slug} failed:`, error.message);
                return { source: source.name, target: target.slug, count: 0, error: error.message };
            }
        });
    }

    async function refreshCompanyBoards(options = {}) {
        const operations = boardSources.flatMap(source => source.targets.map(target => () => refreshBoard(source, target, options)));
        const results = [];
        const concurrency = 4;
        let cursor = 0;
        async function worker() {
            while (cursor < operations.length) {
                const operation = operations[cursor++];
                results.push(await operation());
            }
        }
        await Promise.all(Array.from({ length: Math.min(concurrency, operations.length) }, worker));
        return results;
    }

    async function refreshForPreferences(preferences, options = {}) {
        const unique = new Map();
        preferences.forEach(pref => unique.set(`${normalizeQuery(pref.role)}|${normalizeQuery(pref.location)}`, pref));
        return Promise.all([...unique.values()].map(pref => refreshSearch(pref.role, pref.location, options)));
    }

    function serializeRow(row) {
        return {
            id: row.id, source: row.source, title: row.title, company: row.company, location: row.location,
            salaryMin: row.salary_min, salaryMax: row.salary_max, workplaceType: row.workplace_type,
            remote: row.workplace_type === 'remote', description: row.description, applyUrl: row.apply_url,
            canonicalKey: row.canonical_key, postedAt: row.posted_at, lastSeenAt: row.last_seen_at,
            metadata: row.metadata || {},
        };
    }

    async function recommendations(preferences, resumeText, limit = 50) {
        if (!preferences.length) return [];
        const roleQueries = preferences.map(pref => normalizeQuery(pref.role));
        const result = await pool.query(
            `SELECT DISTINCT p.* FROM job_postings p
             LEFT JOIN job_search_results r ON r.job_id=p.id
             WHERE p.active=true
               AND p.last_seen_at > now() - ($1 * interval '1 day')
               AND (r.role_query = ANY($2::text[]) OR p.source IN ('greenhouse','lever','ashby','workable'))
             ORDER BY p.posted_at DESC NULLS LAST
             LIMIT 5000`,
            [retentionDays, roleQueries]
        );
        return rankJobs(preferences, resumeText, result.rows.map(serializeRow), limit).map(job => ({
            id: job.id, source: job.source, title: job.title, company: job.company, location: job.location,
            salaryMin: job.salaryMin, salaryMax: job.salaryMax, workplaceType: job.workplaceType,
            remote: job.remote, applyUrl: job.applyUrl, postedAt: job.postedAt,
            matchScore: job.matchScore, matchReasons: job.matchReasons, matchedRole: job.matchedRole,
            matchDetails: job.matchDetails,
        }));
    }

    async function status() {
        const [counts, syncs] = await Promise.all([
            pool.query(`SELECT source, count(*)::int AS count, max(last_seen_at) AS "lastSeenAt" FROM job_postings WHERE active=true GROUP BY source ORDER BY source`),
            pool.query(`SELECT sync_key AS "syncKey", source, status, job_count AS "jobCount", error, finished_at AS "finishedAt" FROM job_source_syncs ORDER BY finished_at DESC LIMIT 30`),
        ]);
        return {
            sources: counts.rows,
            recentSyncs: syncs.rows,
            configuredBoards: boardSources.reduce((total, source) => total + source.targets.length, 0),
            refreshMinutes: Math.round(ttlMs / 60000),
        };
    }

    async function initialize() {
        await ensureSchema();
        logger.log('Job Portal tables ready');
        refreshCompanyBoards().catch(error => logger.warn('Initial company-board refresh failed:', error.message));
        timer = setInterval(() => {
            refreshCompanyBoards({ force: true }).catch(error => logger.warn('Scheduled company-board refresh failed:', error.message));
        }, ttlMs);
        timer.unref?.();
    }

    function stop() { if (timer) clearInterval(timer); }

    return { initialize, recommendations, refreshCompanyBoards, refreshForPreferences, status, stop };
}

module.exports = { createJobService };
