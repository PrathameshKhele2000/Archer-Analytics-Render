export interface JwtPayload {
  sub: number;
  email: string;
  roles: string[];
  permissions: string[];
}

/** Shape attached to `req.user` after JWT validation. */
export interface AuthenticatedUser {
  id: number;
  email: string;
  fullName?: string;
  roles: string[];
  permissions: string[];
}
