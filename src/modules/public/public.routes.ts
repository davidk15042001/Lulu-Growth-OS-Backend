import { Router, type RequestHandler } from 'express';
import { dbRateLimit } from '../../middlewares/rateLimit.middleware.js';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import * as controller from './landing-kpis.controller.js';

const router = Router();
const databaseRateLimiter = dbRateLimit({
  keyPrefix: 'public:landing-kpis',
  windowMs: 60 * 1000,
  limit: 60,
  message: 'Live KPI data is temporarily rate limited. Please try again shortly.',
});

// The login page must remain renderable during a database outage. Rate limiting
// fails open only for the limiter's own database error; the KPI service still
// returns an explicit unavailable payload and never exposes provider errors.
const bestEffortDatabaseRateLimiter: RequestHandler = (req, res, next) => {
  void databaseRateLimiter(req, res, (error?: unknown) => {
    if (error) {
      next();
      return;
    }
    next();
  }).catch(() => next());
};

router.route('/landing-kpis')
  .get(bestEffortDatabaseRateLimiter, controller.get)
  .all(methodNotAllowed);

export default router;
