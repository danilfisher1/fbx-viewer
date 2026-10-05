-- Проекты для просмотра по ссылке: модели лежат на Яндекс Диске (публичная ссылка на папку или архив),
-- в базе — только название, короткий slug для ссылки /p/<slug> и ссылка на Диск.
create table if not exists projects (
  id serial primary key,
  slug text unique not null,
  name text not null,
  yandex_url text not null,
  created_at timestamptz not null default now()
);
