-- Hourly replacement selects a day, independent of surface or subnet.
-- Existing surface/subnet-leading indexes require a full history scan.
CREATE INDEX idx_surface_uptime_day ON surface_uptime_daily(day);
