export interface Subject { userId: string; roles: string[]; }
export interface UserRecord { id: string; username: string; passwordHash: string; roles: string[]; }
export interface IdentityProvider {
  authenticate(username: string, password: string): Promise<Subject>;
  listUsers(): Promise<Array<{ id: string; username: string; roles: string[] }>>;
}
export class AuthError extends Error {
  constructor(public code: 'AUTH_FAILED' | 'USER_NOT_FOUND', message: string) { super(message); }
}
