// IP del cliente para rate limits y auditoría.
//
// El primer valor de `x-forwarded-for` lo puede escribir el propio cliente (cada
// proxy AGREGA al final), así que usarlo como llave de rate limit permitía saltarse
// el límite cambiando la cabecera en cada request. Se prefieren las cabeceras que
// pone la infraestructura (Cloudflare / gateway) y, como último recurso, el ÚLTIMO
// salto de x-forwarded-for, que es el que agregó el proxy más cercano.
export function getClientIp(req: Request): string | null {
  const direct = req.headers.get('cf-connecting-ip') ?? req.headers.get('x-real-ip');
  if (direct?.trim()) return direct.trim();

  const hops = (req.headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  return hops.length > 0 ? hops[hops.length - 1] : null;
}

// Solo IPv4/IPv6 literales: el valor termina en una URL de un tercero (ip.guide).
export function isPlausibleIp(ip: string): boolean {
  return /^[0-9a-fA-F:.]{3,45}$/.test(ip);
}
