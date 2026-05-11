export function readJsonResponse<T = unknown>(
  response: Response,
  fallbackMessage: string,
): Promise<T>;
