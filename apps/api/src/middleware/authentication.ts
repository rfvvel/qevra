import type { RequestHandler } from 'express';
import { getSupabaseAuth } from '../config/supabase.js';
import { HttpError } from '../shared/http-error.js';

export const requireAuth: RequestHandler = async (req, _res, next) => {
  const match = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '');
  if (!match?.[1]) throw new HttpError(401, 'UNAUTHENTICATED', 'A valid access token is required.');
  // getUser validates the token with the configured Supabase Auth server, never trusting decoded claims alone.
  const { data, error } = await getSupabaseAuth().auth.getUser(match[1]);
  if (error || !data.user) throw new HttpError(401, 'UNAUTHENTICATED', 'A valid access token is required.');
  req.actor = { userId: data.user.id, isAnonymous: data.user.is_anonymous === true };
  next();
};

export const requireStaff: RequestHandler = (req, _res, next) => {
  if (!req.actor) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required.');
  if (req.actor.isAnonymous) throw new HttpError(403, 'FORBIDDEN', 'Staff authentication is required.');
  next();
};
