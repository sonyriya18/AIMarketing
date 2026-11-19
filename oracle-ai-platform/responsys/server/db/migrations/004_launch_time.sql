-- Account-local launch clock time, optional for older/date-only exports.
ALTER TABLE campaign_launch_facts ADD COLUMN launch_time time;
