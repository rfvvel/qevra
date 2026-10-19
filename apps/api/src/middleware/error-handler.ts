import { ZodError } from 'zod';
import type { ErrorRequestHandler } from 'express';
import { HttpError } from '../shared/http-error.js';

export const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  if (error instanceof ZodError) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: error.issues.map(issue => issue.path.join('.') + ': ' + issue.message).join('; ') } });
    return;
  }
  if (typeof error === 'object' && error !== null && 'code' in error) {
    if (error.code === '23505') {
      res.status(409).json({ error: { code: 'CONFLICT', message: 'That slug, prefix, name or membership is already in use.' } }); return;
    }
    if (error.code === '23503' || error.code === '23514' || error.code === '22003') {
      res.status(400).json({ error: { code: 'INVALID_RELATIONSHIP', message: 'The configuration violates a data constraint.' } }); return;
    }
  }
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof SyntaxError && 'status' in error && error.status === 400) {
    res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Invalid JSON request body.' } });
    return;
  }
  console.error('Unhandled request error.');
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } });
};
