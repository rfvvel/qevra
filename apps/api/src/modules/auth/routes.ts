import { Router } from 'express';
import { requireAuth, requireStaff } from '../../middleware/authentication.js';

export const authRouter = Router();
authRouter.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
authRouter.get('/session', requireAuth, (req, res) => {
  res.json({ authenticated: true, isAnonymous: req.actor!.isAnonymous });
});
// This verifies a permanent Auth identity only; it grants no business access.
authRouter.get('/staff', requireAuth, requireStaff, (_req, res) => {
  res.json({ authenticated: true, isAnonymous: false });
});
