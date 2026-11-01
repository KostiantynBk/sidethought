import { useEffect, useState, type FormEvent } from 'react';
import type { ProjectSpace } from '../../src/memory/types.js';
import { Composer, Conversation, Inspector, Project } from './components.js';
import { MemoryPanel } from './MemoryPanel.js';
import { ResearchPanel } from './ResearchPanel.js';
import { InputStatus } from './InputStatus.js';
import { projectApi } from './project-api.js';
import { useComposer } from './useComposer.js';
import { useConnection } from './useConnection.js';

function ProjectChat({ project }: { project: ProjectSpace }) {
  const connection = useConnection(true, project.id);
  const composer = useComposer(connection);
  const [memoryOpen, setMemoryOpen] = useState(false);
  return <>
    <h2>{project.name}</h2>
    <Conversation view={connection.view} />
    <Composer draft={composer.draft} onTyping={composer.onTyping}
      onBlur={composer.endActivity} onCommit={composer.commit} />
    <InputStatus projectId={project.id} retry={inputId => connection.send('input.retry', { inputIds: [inputId] })} />
    <ResearchPanel
      jobs={connection.view.jobs}
      findings={connection.view.findings}
      onCancel={jobId => { connection.send('job.cancelRequested', { jobId }); }}
    />
    <Project items={connection.view.items} />
    <button type="button" onClick={() => setMemoryOpen(!memoryOpen)}>
      {memoryOpen ? 'Hide' : 'Open'} reviewed cross-project memory
    </button>
    {memoryOpen && <MemoryPanel projectId={project.id} />}
    <Inspector decisions={connection.view.decisions} />
  </>;
}

export function Workspace() {
  const [projects, setProjects] = useState<ProjectSpace[]>([]);
  const [projectId, setProjectId] = useState('local');
  const [name, setName] = useState('');
  const [model, setModel] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    projectApi<{ projects: ProjectSpace[]; model: string }>('/projects').then(result => {
      if (!active) return;
      setProjects(result.projects);
      setModel(result.model);
    }).catch(() => { if (active) setError('Could not load projects. Please refresh.'); });
    return () => { active = false; };
  }, []);
  async function create(event: FormEvent) {
    event.preventDefault();
    try {
      const result = await projectApi<{ project: ProjectSpace }>('/projects', 'POST', { name });
      setProjects(previous => [...previous, result.project]);
      setProjectId(result.project.id);
      setName('');
      setError('');
    } catch (failure) {
      setError((failure as Error).message);
    }
  }
  async function enable(enabled: boolean) {
    try {
      const result = await projectApi<{ project: ProjectSpace }>(`/projects/${projectId}/memory`, 'PUT', { enabled });
      setProjects(previous => previous.map(project => project.id === result.project.id ? result.project : project));
      setError('');
    } catch (failure) {
      setError((failure as Error).message);
    }
  }
  const project = projects.find(candidate => candidate.id === projectId);
  return <main>
    <h1>Sidethought <small>
      {model === 'meta' ? 'Meta Spark' : model === 'dev' ? 'dev model: no real AI' : ''}
    </small></h1>
    {error && <p role="alert">{error}</p>}
    <section aria-label="Project workspace">
      <label>Active project<select value={projectId} onChange={e => setProjectId(e.target.value)}>
        {projects.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
      </select></label>
      <p>Projects keep separate conversations. Switching discards an unsent draft.</p>
      <form onSubmit={event => { void create(event); }}>
        <label>New project name
          <input value={name} maxLength={100} onChange={e => setName(e.target.value)} required />
        </label>
        <button>Create project</button>
      </form>
      {project && <label><input type="checkbox" checked={project.memoryEnabled}
        onChange={e => { void enable(e.target.checked); }} />
        Use relevant shared lessons for new replies in this project
      </label>}
      {project && <p role="status">
        {`Cross-project recall is ${project.memoryEnabled ? 'ON' : 'OFF'} for ${project.name}.`}
      </p>}
      <p>Retrieval is off by default in each new project. Disabling it does not erase earlier conversation.</p>
    </section>
    {project && <ProjectChat key={project.id} project={project} />}
  </main>;
}
