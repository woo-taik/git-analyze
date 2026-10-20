import { Module } from '@nestjs/common';
import { CommandService } from './command.service.js';

@Module({ providers: [CommandService] })
export class CliModule {}
