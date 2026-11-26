import { createApiServer } from '../backend/src/api.mjs';

const server = createApiServer();
const requestHandler = server.listeners('request')[0];

export default function handler(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  const routedPath = url.searchParams.get('path');

  if (routedPath !== null) {
    url.searchParams.delete('path');
    req.url = `/api/${routedPath}${url.search}`;
  }

  return requestHandler(req, res);
}
