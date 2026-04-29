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
  await models.sequelize.query('CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;');

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

  try {
    await models.sequelize.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type WHERE typname = 'age_eligibility'
        ) THEN
          CREATE TYPE age_eligibility AS (
            age_max integer,
            age_min integer,
            all_ages bool,
            population_served varchar
          );
        END IF;
      END$$;
    `);

    await models.sequelize.query(`
      ALTER TABLE locations
      ALTER COLUMN last_validated_at SET DEFAULT NOW();
    `);

    await models.sequelize.query(`
      ALTER TABLE locations DROP COLUMN IF EXISTS name_vector;
      ALTER TABLE locations ADD COLUMN name_vector tsvector
        GENERATED ALWAYS AS (to_tsvector('english', name)) STORED;
      ALTER TABLE organizations DROP COLUMN IF EXISTS name_vector;
      ALTER TABLE organizations ADD COLUMN name_vector tsvector
        GENERATED ALWAYS AS (to_tsvector('english', name)) STORED;
      ALTER TABLE services DROP COLUMN IF EXISTS name_vector;
      ALTER TABLE services ADD COLUMN name_vector tsvector
        GENERATED ALWAYS AS (to_tsvector('english', name)) STORED;
      ALTER TABLE services DROP COLUMN IF EXISTS description_vector;
      ALTER TABLE services ADD COLUMN description_vector tsvector
        GENERATED ALWAYS AS (to_tsvector('english', description)) STORED;
      ALTER TABLE taxonomies DROP COLUMN IF EXISTS name_vector;
      ALTER TABLE taxonomies ADD COLUMN name_vector tsvector
        GENERATED ALWAYS AS (to_tsvector('english', name)) STORED;
    `);

    await models.sequelize.query(`
      create or replace function get_last_validated_date_for_location(_location_id uuid)
         returns timestamp with time zone
         language sql
        as
      $$
      select max(metadata.created_at)
      from locations
      left join service_at_locations sal on sal.location_id = locations.id
      left join services on sal.service_id = services.id
      left join service_languages on service_languages.service_id = services.id
      left join holiday_schedules on holiday_schedules.service_id = services.id
      left join service_areas on service_areas.service_id = services.id
      left join eligibility on eligibility.service_id = services.id
      left join service_taxonomy_specific_attributes on service_taxonomy_specific_attributes.service_id = services.id
      left join required_documents on required_documents.service_id = services.id
      left join documents_infos on documents_infos.service_id = services.id
      left join phones on (phones.service_id = services.id or phones.location_id = locations.id)
      left join event_related_info on (event_related_info.service_id = services.id or event_related_info.location_id = locations.id)
      left join accessibility_for_disabilities on accessibility_for_disabilities.location_id = locations.id
      join metadata on (
        (metadata.resource_table = 'locations' and metadata.resource_id = locations.id) or
        (metadata.resource_table = 'accessibility_for_disabilities' and metadata.resource_id = accessibility_for_disabilities.id) or
        (metadata.resource_table = 'service_languages' and metadata.resource_id = service_languages.id) or
        (metadata.resource_table = 'holiday_schedules' and metadata.resource_id = holiday_schedules.id) or
        (metadata.resource_table = 'service_areas' and metadata.resource_id = service_areas.id) or
        (metadata.resource_table = 'eligibility' and metadata.resource_id = eligibility.id) or
        (metadata.resource_table = 'service_taxonomy_specific_attributes' and metadata.resource_id = service_taxonomy_specific_attributes.id) or
        (metadata.resource_table = 'required_documents' and metadata.resource_id = required_documents.id) or
        (metadata.resource_table = 'documents_infos' and metadata.resource_id = documents_infos.id) or
        (metadata.resource_table = 'phones' and metadata.resource_id = phones.id) or
        (metadata.resource_table = 'event_related_info' and metadata.resource_id = event_related_info.id) or
        (metadata.resource_table = 'services' and metadata.resource_id = services.id)
      )
      where locations.id = _location_id
      $$;
    `);

    await models.sequelize.query(`
      create or replace function update_last_validated_at_on_location(
        loc_id uuid,
        _last_validated_at timestamp with time zone default null
      )
         returns void
         language plpgsql
        as
      $$
      begin
        update locations set last_validated_at = (
          CASE
            when _last_validated_at is null then NOW()
            else _last_validated_at
          end
        )
        where id = loc_id;
      end;
      $$;
    `);

    await models.sequelize.query(`
      create or replace function update_last_validated_at_on_locations(location_ids uuid[])
         returns void
         language plpgsql
        as
      $$
      declare
        location_id uuid;
      begin
        IF location_ids IS NOT NULL THEN
          FOREACH location_id IN array location_ids
          LOOP
            PERFORM update_last_validated_at_on_location(location_id);
          END LOOP;
        end if;
      end;
      $$;
    `);

  } catch (setupError) {
    console.error('test DB setup failed:', setupError.message);
    throw setupError;
  }
});


afterAll(async () => {
  await models.sequelize.close();
});



