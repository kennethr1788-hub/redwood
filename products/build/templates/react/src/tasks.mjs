export function addTask(tasks, title) {
  const text = title.trim();
  if (!text || text.length > 120)
    throw new Error("Use a task title between 1 and 120 characters.");
  return [...tasks, { id: crypto.randomUUID(), title: text, done: false }];
}
export function toggleTask(tasks, id) {
  return tasks.map((task) =>
    task.id === id ? { ...task, done: !task.done } : task,
  );
}
