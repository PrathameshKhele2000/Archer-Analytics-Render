/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Absolute base URL of the backend API. Leave empty for local dev (Vite proxy)
   * and Docker (nginx proxy). Set to the backend's URL when the frontend and API
   * are on separate origins (e.g. Render static site + separate web service).
   */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
