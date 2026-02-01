"""
Agent Identity Middleware for FastAPI

Copy-paste this into your FastAPI project.
Verifies that incoming requests have a valid Agent Identity.

Usage:
    from agent_identity import require_agent, optional_agent, AgentIdentity

    # Block requests without verified agent
    @app.post("/api/agent-task")
    async def handle_task(agent: AgentIdentity = Depends(require_agent)):
        print(f"Agent: {agent.did}, Reputation: {agent.reputation}")
        return {"status": "ok"}

    # Allow but track agent identity
    @app.get("/api/data")
    async def get_data(agent: AgentIdentity | None = Depends(optional_agent)):
        if agent:
            print(f"Verified agent: {agent.name}")
        return {"data": "..."}
"""

import httpx
from typing import Optional
from functools import lru_cache
from datetime import datetime, timedelta
from pydantic import BaseModel
from fastapi import Header, HTTPException, Depends

AGENT_IDENTITY_API = "https://agent-identity.onrender.com"
CACHE_TTL = timedelta(minutes=5)


class AgentIdentity(BaseModel):
    """Verified agent identity data"""
    verified: bool
    did: str
    name: str
    reputation: float
    tasks_completed: int
    registered_at: str
    flags: int
    verification_url: str


# Simple in-memory cache
_cache: dict[str, tuple[datetime, Optional[AgentIdentity]]] = {}


async def verify_agent(did: str) -> Optional[AgentIdentity]:
    """
    Verify an agent DID against the Agent Identity API.
    Returns AgentIdentity if verified, None otherwise.
    """
    # Check cache
    if did in _cache:
        cached_time, cached_data = _cache[did]
        if datetime.now() < cached_time + CACHE_TTL:
            return cached_data

    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{AGENT_IDENTITY_API}/verify/{did}",
                timeout=10.0
            )
            
            if response.status_code != 200:
                print(f"[AgentIdentity] API error: {response.status_code}")
                return None

            data = response.json()
            
            if data.get("verified"):
                agent = AgentIdentity(**data)
                _cache[did] = (datetime.now(), agent)
                return agent
            else:
                _cache[did] = (datetime.now(), None)
                return None

    except Exception as e:
        print(f"[AgentIdentity] Verification failed: {e}")
        return None


async def require_agent(
    x_agent_did: Optional[str] = Header(None, alias="X-Agent-DID"),
    x_agent_identity: Optional[str] = Header(None, alias="X-Agent-Identity"),
) -> AgentIdentity:
    """
    FastAPI dependency: Require verified Agent Identity.
    Raises 401 HTTPException if agent is not verified.
    """
    agent_did = x_agent_did or x_agent_identity
    
    if not agent_did:
        raise HTTPException(
            status_code=401,
            detail={
                "error": "Agent identity required",
                "message": "Include X-Agent-DID header with your agent's DID",
                "register_url": "https://agent-identity.onrender.com/"
            }
        )

    agent = await verify_agent(agent_did)
    
    if not agent:
        raise HTTPException(
            status_code=401,
            detail={
                "error": "Agent not verified",
                "message": "The provided DID is not registered or verified",
                "did": agent_did,
                "register_url": "https://agent-identity.onrender.com/"
            }
        )

    return agent


async def optional_agent(
    x_agent_did: Optional[str] = Header(None, alias="X-Agent-DID"),
    x_agent_identity: Optional[str] = Header(None, alias="X-Agent-Identity"),
) -> Optional[AgentIdentity]:
    """
    FastAPI dependency: Optional Agent Identity.
    Returns AgentIdentity if provided and verified, None otherwise.
    """
    agent_did = x_agent_did or x_agent_identity
    
    if not agent_did:
        return None

    return await verify_agent(agent_did)


def require_reputation(min_reputation: float):
    """
    FastAPI dependency factory: Require minimum reputation.
    
    Usage:
        @app.post("/premium-endpoint")
        async def premium(agent: AgentIdentity = Depends(require_reputation(4.0))):
            ...
    """
    async def dependency(agent: AgentIdentity = Depends(require_agent)) -> AgentIdentity:
        if agent.reputation < min_reputation:
            raise HTTPException(
                status_code=403,
                detail={
                    "error": "Insufficient reputation",
                    "message": f"This endpoint requires minimum {min_reputation} reputation",
                    "your_reputation": agent.reputation,
                    "did": agent.did
                }
            )
        return agent
    
    return dependency


# Example usage in a FastAPI app:
if __name__ == "__main__":
    from fastapi import FastAPI
    import uvicorn

    app = FastAPI(title="Agent Identity Example")

    @app.get("/public")
    async def public_endpoint():
        return {"message": "This endpoint is open to everyone"}

    @app.get("/agent-only")
    async def agent_only(agent: AgentIdentity = Depends(require_agent)):
        return {
            "message": f"Hello, {agent.name}!",
            "your_reputation": agent.reputation,
            "tasks_completed": agent.tasks_completed
        }

    @app.get("/premium")
    async def premium_endpoint(agent: AgentIdentity = Depends(require_reputation(4.0))):
        return {"message": "Welcome to the premium endpoint!"}

    @app.get("/tracked")
    async def tracked_endpoint(agent: Optional[AgentIdentity] = Depends(optional_agent)):
        if agent:
            return {"message": f"Tracked request from {agent.name}"}
        return {"message": "Anonymous request"}

    uvicorn.run(app, host="0.0.0.0", port=8000)
