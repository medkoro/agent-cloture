import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { ClosingController } from './closing.controller.js';
import { ClosingService, InMemoryClosingSessionStore, type ClosingSessionStore } from '../platform/closing_service.js';
import { MysqlClosingSessionStore } from '../platform/mysql_store.js';
import { createPool } from 'mysql2/promise';

@Module({
  controllers: [ClosingController],
  providers: [
    {
      provide: 'CLOSING_STORE',
      useFactory: (): ClosingSessionStore => {
        if (process.env.MYSQL_HOST) {
          return new MysqlClosingSessionStore(createPool({
            host: process.env.MYSQL_HOST,
            port: Number(process.env.MYSQL_PORT ?? 3306),
            database: process.env.MYSQL_DATABASE ?? 'agent_cloture',
            user: process.env.MYSQL_USER ?? 'root',
            password: process.env.MYSQL_PASSWORD ?? 'root',
            connectionLimit: 5,
          }));
        }
        return new InMemoryClosingSessionStore();
      },
    },
    {
      provide: ClosingService,
      inject: ['CLOSING_STORE'],
      useFactory: (store: ClosingSessionStore) => new ClosingService(store, join(process.cwd(), 'sessions')),
    },
  ],
  exports: [ClosingService],
})
export class AppModule {}
