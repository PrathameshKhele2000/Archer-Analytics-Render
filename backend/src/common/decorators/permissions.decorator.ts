import { SetMetadata } from "@nestjs/common";

export const PERMISSIONS_KEY = "permissions";
/** Requires the authenticated user to hold ALL listed permission codes. */
export const Permissions = (...codes: string[]) => SetMetadata(PERMISSIONS_KEY, codes);
