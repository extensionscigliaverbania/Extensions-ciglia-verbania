-- Disponibilita' eccezionali aggiunte il 15 novembre 2026.
-- Data locale Europe/Rome: 16 novembre 2026.
-- Eseguire solo se si deve ripristinare questa modifica in un ambiente nuovo.
insert into public.special_slots (slot_date, starts_at) values
  ('2026-11-16', '10:30'),
  ('2026-11-16', '14:00')
on conflict (slot_date, starts_at) do nothing;
