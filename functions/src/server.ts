/**
 * Serves the callables over plain HTTP, so the backend can run on any host
 * that runs Node instead of only on Cloud Functions.
 *
 * Cloud Functions needs the Blaze plan. Firebase Auth and Firestore do not —
 * they are free on Spark, and the Admin SDK reaches them from anywhere with a
 * service account. Only the compute has to move, and barely at all: an
 * `onCall` handler *is* an Express request handler. It verifies the caller's
 * ID token itself and writes the callable wire format — `{result}`, or
 * `{error: {message, status}}` with a matching HTTP status. Both clients
 * already speak exactly that:
 *
 *   - the app posts it by hand in `FunctionsClient._callEmulator`
 *   - the dashboard gets it from `getFunctions(app, '<origin>')`
 *
 * So the handlers are mounted unmodified, and the protocol is identical to
 * the deployed one. Moving back to Cloud Functions later is a config change.
 */
import './bootstrap';

import express, { type Request, type Response } from 'express';

import * as functions from './index';
import { closeStaleShifts } from './attendance/clock';

/** An `onCall` export, which firebase-functions tags with a callable trigger. */
type Callable = ((req: Request, res: Response) => void) & {
  __endpoint?: { callableTrigger?: unknown };
};

const isCallable = (value: unknown): value is Callable =>
  typeof value === 'function' &&
  (value as Callable).__endpoint?.callableTrigger !== undefined;

export const app = express();

// Callables are POST-only JSON. The handler reads req.body itself, so it has
// to be parsed before dispatch; the limit is generous enough for an offline
// queue flushing a backlog of clock events.
app.use(express.json({ limit: '1mb' }));

const callables = new Map<string, Callable>(
  Object.entries(functions).filter(([, v]) => isCallable(v)) as [
    string,
    Callable,
  ][],
);

/**
 * Liveness, and a cheap way to confirm a deploy picked up every function.
 *
 * Deliberately does not touch Firestore: a free host may cold-start this on
 * every ping, and a health check that bills reads is a health check that
 * discourages monitoring.
 */
app.get('/', (_req: Request, res: Response) => {
  res.json({
    service: 'motiroong-backend',
    callables: [...callables.keys()].sort(),
    count: callables.size,
  });
});

/**
 * Closes shifts left open overnight — the nightly job, which has no scheduler
 * off Cloud Functions. Drive it from any free cron that can send a header
 * (GitHub Actions, cron-job.org) and set CRON_SECRET to keep it private.
 *
 * Without a secret configured the route refuses to run rather than exposing
 * a public write, since a missing environment variable is the likeliest
 * deployment mistake and the safest failure is a closed door.
 */
app.post('/tasks/close-stale-shifts', async (req: Request, res: Response) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    res.status(503).json({ error: 'CRON_SECRET is not configured.' });
    return;
  }
  if (req.get('x-cron-secret') !== secret) {
    res.status(403).json({ error: 'Forbidden.' });
    return;
  }

  try {
    const closed = await closeStaleShifts();
    res.json({ closed });
  } catch (error) {
    console.error('close-stale-shifts failed', error);
    res.status(500).json({ error: 'Failed to close stale shifts.' });
  }
});

// One route per callable, named exactly as it is deployed, so the clients'
// URLs are the same shape either way.
for (const [name, handler] of callables) {
  app.all(`/${name}`, (req: Request, res: Response) => handler(req, res));
}

app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: {
      message: `No such function: ${req.path.replace(/^\//, '')}`,
      status: 'NOT_FOUND',
    },
  });
});

// Started directly (Render, Railway, a container, localhost) rather than
// imported by a serverless wrapper.
if (require.main === module) {
  const port = Number(process.env.PORT) || 8080;
  app.listen(port, () => {
    console.log(`motiroong-backend listening on :${port}`);
    console.log(`${callables.size} callables mounted`);
  });
}

export default app;
