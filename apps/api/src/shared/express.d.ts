import type { BusinessRole } from '@qevra/contracts';
declare global {
  namespace Express {
    interface Request {
      actor?: { userId: string; isAnonymous: boolean };
      membership?: { id: string; businessId: string; role: BusinessRole };
    }
  }
}
export {};
