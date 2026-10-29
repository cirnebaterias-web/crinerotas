begin;

drop function if exists api.get_scrap_agenda(date, date, text, text, uuid, uuid, text);
drop function if exists private.scrap_agenda_cursor(date, text, timestamptz, uuid);
drop index if exists api.pickup_schedules_agenda_order;

commit;
