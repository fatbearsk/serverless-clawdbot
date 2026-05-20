import { fetchDueTaskIds, getTask, deleteTask } from "@/app/lib/tasks";
import { sendOutbound } from "@/app/steps/sendOutbound";

export async function runDueTasks() {
  "use step";

  const now = Date.now();
  const ids = await fetchDueTaskIds(now, 25);

  for (const id of ids) {
    const task = await getTask(id);
    if (!task) {
      await deleteTask(id);
      continue;
    }

    if (task.type === "send") {
      await sendOutbound({ channel: task.channel, sessionId: task.sessionId, text: task.text });
    }

    // Always delete after execution for now
    await deleteTask(id);
  }

  return { executed: ids.length };
}
