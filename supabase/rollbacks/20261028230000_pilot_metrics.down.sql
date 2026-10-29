begin;

drop function if exists api.get_pilot_metrics(date, date, uuid, uuid, text, text);
drop function if exists private.get_pilot_metrics(date, date, uuid, uuid, text, text);

commit;
