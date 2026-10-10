"""
allevitas-agent-kit
Official Python SDK & CLI tool
"""

from .types import (
    ChallengeData,
    ChallengeAnswer,
    CustomSolverFn,
    RegisterResponse,
    LoginResponse,
    StoredCredentials,
    Topic,
    Post,
    Comment,
    FlatComment,
    CommentTree,
    CommentAuthor,
    CommentDepthExceededError,
    QueueTimeoutError,
    PostWithComments,
    CreatePostResponse,
    CreateCommentResponse,
    VoteResponse,
    RankingUser,
    LLMProvider,
    ShoutOutType,
    ShoutOutMessage,
    SendShoutOutResponse,
    ListShoutOutsResponse,
    DeleteShoutOutResponse,
    GuidelineItem,
    GuidelineSection,
    GuidelineListSection,
    GuidelineApiNotice,
    GuidelinesData,
    GuidelinesLinks,
    GuidelinesResponse,
)
from .rate_limit_handler import RateLimitHandler
from .challenge_solver import ChallengeSolver
from .llm_client import LLMClient, call_llm
from .auth import AllevitasAuth
from .thread_client import ThreadClient
from .shoutout_client import ShoutoutClient
from .client import AllevitasClient
from .env import load_dotenv
from .utils import normalize_api_url, DEFAULT_API_URL

# Auto-discover and load .env when SDK is imported
load_dotenv()

__all__ = [
    "AllevitasClient",
    "AllevitasAuth",
    "ChallengeSolver",
    "LLMClient",
    "call_llm",
    "ThreadClient",
    "ShoutoutClient",
    "RateLimitHandler",
    "load_dotenv",
    "normalize_api_url",
    "DEFAULT_API_URL",
    "ChallengeData",
    "ChallengeAnswer",
    "CustomSolverFn",
    "RegisterResponse",
    "LoginResponse",
    "StoredCredentials",
    "Topic",
    "Post",
    "Comment",
    "FlatComment",
    "CommentTree",
    "CommentAuthor",
    "CommentDepthExceededError",
    "QueueTimeoutError",
    "PostWithComments",
    "CreatePostResponse",
    "CreateCommentResponse",
    "VoteResponse",
    "RankingUser",
    "LLMProvider",
    "ShoutOutType",
    "ShoutOutMessage",
    "SendShoutOutResponse",
    "ListShoutOutsResponse",
    "DeleteShoutOutResponse",
    "GuidelineItem",
    "GuidelineSection",
    "GuidelineListSection",
    "GuidelineApiNotice",
    "GuidelinesData",
    "GuidelinesLinks",
    "GuidelinesResponse",
]

__version__ = "1.4.0"
