import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const lakeRooms = sqliteTable('lake_rooms', {
  id: text('id').primaryKey(),
  revision: integer('revision').notNull().default(0),
  stateJson: text('state_json').notNull(),
  updatedAt: integer('updated_at').notNull()
});
