const util = require('util');
const exec = util.promisify(require('child_process').exec);

jest.setTimeout(60000);

process.env.DATABASE_NAME = 'test';
process.env.DATABASE_LOGGING = 'false';
process.env.OPENAI_API_KEY = 'fake';
process.env.DATABASE_USER = 'streetlives';
process.env.DATABASE_PASSWORD = 'password';
process.env.DATABASE_HOST = 'localhost';
process.env.DATABASE_PORT = '5432';

const models = require('../src/models');

async function execScript(script) {
  const promise = exec(
    script,
    { env: process.env },
  );

  const { child } = promise;

  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);

  await promise;
}

beforeAll(async () => {
  try {
    await models.sequelize.query(`
      DO $$
      DECLARE _table record;
      BEGIN
        FOR _table IN
          SELECT table_name FROM information_schema.tables t
          inner join pg_catalog.pg_tables p on
          p.tablename = t.table_name and p.schemaname = t.table_schema
          where table_schema = 'public' and
            table_type='BASE TABLE' and p.tableowner = 'streetlives'
            and table_name != 'spatial_ref_sys'
        LOOP
        EXECUTE format('DROP TABLE IF EXISTS %I CASCADE', _table.table_name);
        END LOOP;
      END$$;
    `);
    console.log('DROP query succeeded');
  } catch (e) {
    console.error('DROP query failed:', e.message);
    throw e;
  }

  try {
    await models.sequelize.query('DROP TYPE IF EXISTS age_eligibility CASCADE;');
    console.log('DROP TYPE age_eligibility succeeded');
  } catch (e) {
    console.error('DROP TYPE age_eligibility failed:', e.message);
    throw e;
  }

  await models.sequelize.query('DROP TABLE IF EXISTS "SequelizeMeta";');
  await models.sequelize.query('DROP TABLE IF EXISTS "sequelize_meta";');
  await models.sequelize.query('DROP TABLE IF EXISTS "nyc_neighborhoods" CASCADE;');

  await models.sequelize.query('CREATE EXTENSION IF NOT EXISTS postgis;');

  try {
    await models.sequelize.sync({ force: true });
  } catch (syncError) {
    console.error('sync failed:', syncError.message);
    if (syncError.parent) {
      console.error('sync parent error:', syncError.parent.message);
    }
    if (syncError.sql) {
      console.error('sync SQL:', syncError.sql);
    }
    throw syncError;
  }

  await models.sequelize.query('ALTER TABLE physical_addresses ADD COLUMN IF NOT EXISTS neighborhood VARCHAR;');

  await execScript('npx sequelize-cli db:migrate --name 20240325142525-location-slugs');
  await execScript('npx sequelize-cli db:migrate --name 20240607172205-age-filter');

  await models.sequelize.query(`
    UPDATE physical_addresses SET neighborhood = 'Chelsea' 
    WHERE postal_code = '10001';
    UPDATE physical_addresses SET neighborhood = 'Lower East Side' 
    WHERE postal_code = '10002';
  `);

  await models.sequelize.query(`
    ALTER TABLE services DROP COLUMN IF EXISTS description_vector;
    ALTER TABLE services ADD COLUMN description_vector tsvector
      GENERATED ALWAYS AS (to_tsvector('english', COALESCE(description, ''))) STORED;
  `);
});

afterAll(async () => {
  await models.sequelize.close();
});