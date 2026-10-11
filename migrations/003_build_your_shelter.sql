-- New scavengers start with NO shelter: the row exists (so FKs/joins keep working) but built = 0 until they gather
-- wood, stone and cloth and run /shelter build. Shelters that already existed (earlier versions) count as built.
ALTER TABLE shelters ADD COLUMN built INTEGER NOT NULL DEFAULT 1 CHECK (built IN (0, 1));
