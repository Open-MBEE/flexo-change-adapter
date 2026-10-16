export type Transport = (url: string, init?: RequestInit) => Promise<Response>;
export const transport: Transport = (url, init) =>
  fetch(url, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(30000),
  });
