import { TodoItem } from '../../../core/agent/todos-from-messages'
import { renderTodoListInjection } from './todoListContext'

const pending = (content: string): TodoItem => ({
  content,
  status: 'pending',
})

const inProgress = (content: string): TodoItem => ({
  content,
  status: 'in_progress',
})

const completed = (content: string): TodoItem => ({
  content,
  status: 'completed',
})

describe('renderTodoListInjection', () => {
  it('renders in_progress items using content', () => {
    const result = renderTodoListInjection({
      type: 'todo-list',
      todos: [inProgress('Run tests')],
    })
    expect(result.content).toContain('[in_progress] Run tests')
  })

  it('renders pending items using content', () => {
    const result = renderTodoListInjection({
      type: 'todo-list',
      todos: [pending('Run tests')],
    })
    expect(result.content).toContain('[pending] Run tests')
  })

  it('renders completed items using content', () => {
    const result = renderTodoListInjection({
      type: 'todo-list',
      todos: [completed('Run tests')],
    })
    expect(result.content).toContain('[completed] Run tests')
  })

  it('preserves original ordering', () => {
    const result = renderTodoListInjection({
      type: 'todo-list',
      todos: [inProgress('A'), completed('B'), pending('C')],
    })
    const text = result.content as string
    const posA = text.indexOf('[in_progress] A')
    const posB = text.indexOf('[completed] B')
    const posC = text.indexOf('[pending] C')
    expect(posA).toBeLessThan(posB)
    expect(posB).toBeLessThan(posC)
  })

  it('wraps output in <current-todo-list> tags', () => {
    const result = renderTodoListInjection({
      type: 'todo-list',
      todos: [pending('A')],
    })
    const text = result.content as string
    expect(text.startsWith('<current-todo-list>')).toBe(true)
    expect(text.endsWith('</current-todo-list>')).toBe(true)
  })

  it('returns a user-role message', () => {
    const result = renderTodoListInjection({
      type: 'todo-list',
      todos: [pending('A')],
    })
    expect(result.role).toBe('user')
  })
})
