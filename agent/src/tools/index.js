import { currentTime, fetchUrl } from './builtin.js';
import { saveNote, searchNotes } from './notes.js';
import { ToolRegistry } from './registry.js';
import { useSkill } from './skills.js';

/** 创建并注册全部工具。新增工具：写一个 ToolDefinition，在这里 register。 */
export function createToolRegistry() {
  return new ToolRegistry()
    .register(currentTime)
    .register(saveNote)
    .register(searchNotes)
    .register(useSkill)
    .register(fetchUrl);
}
