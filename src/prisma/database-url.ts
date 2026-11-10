export function databaseUrl(env = process.env) {
  const { DB_HOST = "localhost", DB_PORT = "3306", MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE } = env;
  return `mysql://${encodeURIComponent(MYSQL_USER!)}:${encodeURIComponent(MYSQL_PASSWORD!)}@${DB_HOST}:${DB_PORT}/${MYSQL_DATABASE}`;
}
