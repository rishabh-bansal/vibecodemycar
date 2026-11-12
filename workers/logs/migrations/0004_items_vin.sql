-- Logs per car: every item is filed under the car's full VIN (NULL when the item does not know it), so an owner
-- can list the cars (GET /v1/cars) and read or export one car's logs (?vin=). Items stored before this migration
-- keep NULL: their bodies carried no VIN. A browser re-uploads its records with the VIN when it next syncs.

ALTER TABLE items ADD COLUMN vin TEXT;
CREATE INDEX items_vin_updated ON items (vin, updated_at);
