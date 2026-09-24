import { Global, Module } from '@nestjs/common';

import { ToolRegistryService } from './tool-registry.service.js';

@Global()
@Module({
  providers: [ToolRegistryService],
  exports: [ToolRegistryService],
})
export class ToolsModule {}
