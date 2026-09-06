ALTER TABLE durable_object_project_specs
    ADD COLUMN secret_refs text[] NOT NULL DEFAULT '{}',
    ADD COLUMN socket_gateway_url text;
