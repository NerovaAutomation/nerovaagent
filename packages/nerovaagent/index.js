import app from './server.js';

const PORT = process.env.PORT || 3333;

export function start() {
  return new Promise((resolve) => {
    const server = app.listen(PORT, () => {
      resolve(server);
    });
  });
}

if (import.meta.main) {
  start().then(() => {
    console.log(`[nerovaagent] API listening on ${PORT}`);
  });
}
