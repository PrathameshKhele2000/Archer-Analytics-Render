import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = "isPublic";
/** Marks a route as exempt from JWT auth (e.g. /auth/login, /health). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
