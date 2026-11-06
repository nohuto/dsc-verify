export function hasExactOrigin(request: Request, origin: string): boolean {
  return request.headers.get('Origin') === origin;
}

export function hasJsonContentType(request: Request): boolean {
  const contentType = request.headers.get('Content-Type');
  return (
    contentType !== null &&
    /^application\/json(?:\s*;\s*charset\s*=\s*(?:[A-Za-z0-9_-]+|"[A-Za-z0-9_-]+"))?$/i.test(
      contentType.trim(),
    )
  );
}
