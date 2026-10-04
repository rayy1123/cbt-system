-- CBT Platform Database Schema DDL (PostgreSQL)
-- Blueprint based on DATABASE.md

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Organizations
CREATE TABLE IF NOT EXISTS organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    code VARCHAR(50) NOT NULL UNIQUE,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Users
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    username VARCHAR(100) NOT NULL,
    email VARCHAR(255),
    password_hash VARCHAR(255) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_users_org_username UNIQUE (organization_id, username)
);

-- 3. Roles
CREATE TABLE IF NOT EXISTS roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(50) NOT NULL UNIQUE,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. User Roles
CREATE TABLE IF NOT EXISTS user_roles (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, role_id)
);

-- 5. Sessions (Server-authoritative)
CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(255) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    invalidated_at TIMESTAMPTZ
);

-- 6. Exams
CREATE TABLE IF NOT EXISTS exams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    duration_seconds INT NOT NULL,
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,
    result_release_policy VARCHAR(50) NOT NULL DEFAULT 'AFTER_EXAM_PERIOD',
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7. Exam Assignments
CREATE TABLE IF NOT EXISTS exam_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    exam_id UUID NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    participant_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_exam_assignments UNIQUE (exam_id, participant_id)
);

-- 8. Questions (Metadata container)
CREATE TABLE IF NOT EXISTS questions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    question_type VARCHAR(50) NOT NULL DEFAULT 'SINGLE_CHOICE',
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 9. Question Versions (Immutable snapshot, answer key isolated server-side)
CREATE TABLE IF NOT EXISTS question_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    question_id UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    version_number INT NOT NULL,
    body JSONB NOT NULL,
    answer_key_restricted JSONB NOT NULL,
    scoring_config JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_question_versions UNIQUE (question_id, version_number)
);

-- 10. Question Options
CREATE TABLE IF NOT EXISTS question_options (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    question_version_id UUID NOT NULL REFERENCES question_versions(id) ON DELETE CASCADE,
    option_key VARCHAR(10) NOT NULL,
    content TEXT NOT NULL,
    position INT NOT NULL
);

-- 11. Exam Questions
CREATE TABLE IF NOT EXISTS exam_questions (
    exam_id UUID NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    question_version_id UUID NOT NULL REFERENCES question_versions(id) ON DELETE RESTRICT,
    position INT NOT NULL,
    points NUMERIC(5,2) NOT NULL DEFAULT 1.00,
    PRIMARY KEY (exam_id, question_version_id)
);

-- 12. Attempts (State machine enforced by server)
CREATE TABLE IF NOT EXISTS attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    exam_id UUID NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    participant_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    attempt_number INT NOT NULL DEFAULT 1,
    state VARCHAR(20) NOT NULL DEFAULT 'NOT_STARTED',
    started_at TIMESTAMPTZ,
    deadline_at TIMESTAMPTZ,
    submitted_at TIMESTAMPTZ,
    finalized_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_attempts UNIQUE (exam_id, participant_id, attempt_number)
);

-- 13. Attempt Questions
CREATE TABLE IF NOT EXISTS attempt_questions (
    attempt_id UUID NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
    question_version_id UUID NOT NULL REFERENCES question_versions(id) ON DELETE RESTRICT,
    position INT NOT NULL,
    PRIMARY KEY (attempt_id, question_version_id)
);

-- 14. Answers (Idempotent submission)
CREATE TABLE IF NOT EXISTS answers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    attempt_id UUID NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
    question_version_id UUID NOT NULL REFERENCES question_versions(id) ON DELETE RESTRICT,
    answer_payload JSONB NOT NULL,
    answered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_attempt_answer UNIQUE (attempt_id, question_version_id)
);

-- 15. Scores
CREATE TABLE IF NOT EXISTS scores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    attempt_id UUID NOT NULL UNIQUE REFERENCES attempts(id) ON DELETE CASCADE,
    raw_score NUMERIC(8,2) NOT NULL DEFAULT 0.00,
    max_score NUMERIC(8,2) NOT NULL DEFAULT 0.00,
    percentage NUMERIC(5,2) NOT NULL DEFAULT 0.00,
    calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    algorithm_version VARCHAR(50) NOT NULL DEFAULT 'v1'
);

-- 16. Audit Events (Immutable logging)
CREATE TABLE IF NOT EXISTS audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(100) NOT NULL,
    target_type VARCHAR(50) NOT NULL,
    target_id UUID,
    outcome VARCHAR(20) NOT NULL,
    request_id VARCHAR(100),
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Minimum Required Indexes
CREATE INDEX IF NOT EXISTS idx_users_org_username ON users(organization_id, username);
CREATE INDEX IF NOT EXISTS idx_exams_org_status ON exams(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_attempts_participant_state ON attempts(participant_id, state);
CREATE INDEX IF NOT EXISTS idx_attempts_exam_participant ON attempts(exam_id, participant_id);
CREATE INDEX IF NOT EXISTS idx_answers_attempt_qversion ON answers(attempt_id, question_version_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_org_created ON audit_events(organization_id, created_at);
