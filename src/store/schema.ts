export const SCHEMA = `
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT,
        stateJson TEXT,
        rev INTEGER
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        projectId TEXT REFERENCES projects(id),
        kind TEXT,
        status TEXT,
        createdAt INTEGER,
        updatedAt INTEGER
      );
      CREATE TABLE IF NOT EXISTS journal (
        sessionId TEXT NOT NULL REFERENCES sessions(id),
        seq INTEGER NOT NULL,
        eventId TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        causalParent TEXT,
        acceptedAt INTEGER NOT NULL,
        observedAt INTEGER,
        payload TEXT NOT NULL,
        PRIMARY KEY(sessionId, seq)
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        sessionId TEXT PRIMARY KEY REFERENCES sessions(id),
        seq INTEGER NOT NULL,
        reducerVersion TEXT NOT NULL,
        stateJson TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage (
        callId TEXT NOT NULL,
        sessionId TEXT NOT NULL,
        role TEXT NOT NULL,
        model TEXT NOT NULL,
        inputTokens INTEGER NOT NULL,
        outputTokens INTEGER NOT NULL,
        searches INTEGER NOT NULL,
        audioSeconds REAL NOT NULL,
        estimatedUsd REAL NOT NULL
      );
`;
