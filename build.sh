#!/usr/bin/env bash
#
# Build script for Sonar — builds for macOS, Linux, and Windows
#
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_ROOT"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
print_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
print_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
print_error() { echo -e "${RED}[ERROR]${NC} $1"; }

usage() {
    cat <<EOF
Usage: $0 [OPTIONS] [TARGETS...]

Build Sonar for macOS, Linux, and/or Windows.

TARGETS:
    macos       Build for macOS (native, requires macOS host)
    linux       Build for Linux x86_64 (via Docker)
    windows     Build for Windows x86_64 (via cross-compilation)
    all         Build for all platforms

OPTIONS:
    -h, --help      Show this help message
    -c, --clean     Clean build artifacts before building
    --debug         Build in debug mode (default is release)

EXAMPLES:
    $0 macos                # Build for macOS only
    $0 linux windows        # Build for Linux and Windows
    $0 all                  # Build for all platforms
    $0 -c all               # Clean and build for all platforms

REQUIREMENTS:
    - macOS:   Native build, no extra requirements
    - Linux:   Docker must be installed and running
    - Windows: Docker must be installed and running

EOF
    exit 0
}

# Parse arguments
TARGETS=()
CLEAN=false
DEBUG=false

while [[ $# -gt 0 ]]; do
    case $1 in
        -h|--help)
            usage
            ;;
        -c|--clean)
            CLEAN=true
            shift
            ;;
        --debug)
            DEBUG=true
            shift
            ;;
        macos|linux|windows|all)
            if [[ "$1" == "all" ]]; then
                TARGETS=(macos linux windows)
            else
                TARGETS+=("$1")
            fi
            shift
            ;;
        *)
            print_error "Unknown option: $1"
            usage
            ;;
    esac
done

# Default to all platforms if none specified
if [[ ${#TARGETS[@]} -eq 0 ]]; then
    print_info "No targets specified. Use '$0 --help' for usage."
    exit 1
fi

# Remove duplicates
TARGETS=($(echo "${TARGETS[@]}" | tr ' ' '\n' | sort -u | tr '\n' ' '))

# Ensure npm dependencies are installed
ensure_deps() {
    if [[ ! -d "node_modules" ]]; then
        print_info "Installing npm dependencies..."
        npm install --no-audit --no-fund
    fi
}

# Clean build artifacts
clean_build() {
    print_info "Cleaning build artifacts..."
    rm -rf src-tauri/target
    rm -rf dist
    print_success "Build artifacts cleaned"
}

# Build for macOS
build_macos() {
    print_info "Building for macOS..."

    if [[ "$(uname)" != "Darwin" ]]; then
        print_error "macOS builds require a macOS host"
        return 1
    fi

    ensure_deps

    local build_args=""
    if [[ "$DEBUG" == "false" ]]; then
        build_args="--bundles dmg app"
    fi

    npx tauri build $build_args

    # Copy artifacts to dist folder
    mkdir -p dist
    if [[ "$DEBUG" == "false" ]]; then
        cp -r src-tauri/target/release/bundle/dmg/*.dmg dist/ 2>/dev/null || true
        cp -r src-tauri/target/release/bundle/macos/*.app dist/ 2>/dev/null || true
    fi

    print_success "macOS build complete"
    echo "  Artifacts:"
    ls -1 dist/*.dmg 2>/dev/null || true
}

# Build for Linux using Docker
build_linux() {
    print_info "Building for Linux (x86_64) via Docker..."

    if ! command -v docker &> /dev/null; then
        print_error "Docker is required for Linux builds"
        print_info "Install Docker: https://docs.docker.com/get-docker/"
        return 1
    fi

    if ! docker info &> /dev/null; then
        print_error "Docker daemon is not running"
        return 1
    fi

    # Build the Docker image if it doesn't exist or Dockerfile changed
    local image_name="sonar-linux-builder"
    print_info "Building Docker image..."
    docker build -t "$image_name" -f linux-build/Dockerfile linux-build/

    # Run the build inside Docker
    print_info "Running Linux build in Docker container..."
    docker run --rm \
        -v "$PROJECT_ROOT:/app" \
        -e HOST_UID="$(id -u)" \
        -e HOST_GID="$(id -g)" \
        "$image_name" \
        /app/linux-build/build.sh

    # Copy artifacts to dist folder
    mkdir -p dist
    cp src-tauri/target/x86_64-unknown-linux-gnu/release/bundle/deb/*.deb dist/ 2>/dev/null || true
    cp src-tauri/target/x86_64-unknown-linux-gnu/release/bundle/appimage/*.AppImage dist/ 2>/dev/null || true

    print_success "Linux build complete"
    echo "  Artifacts:"
    ls -1 dist/*.deb dist/*.AppImage 2>/dev/null || true
}

# Build for Windows using Docker
build_windows() {
    print_info "Building for Windows (x86_64) via Docker..."

    if ! command -v docker &> /dev/null; then
        print_error "Docker is required for Windows builds"
        print_info "Install Docker: https://docs.docker.com/get-docker/"
        return 1
    fi

    if ! docker info &> /dev/null; then
        print_error "Docker daemon is not running"
        return 1
    fi

    # Build the Docker image
    local image_name="sonar-windows-builder"
    print_info "Building Docker image (this may take a while on first run)..."
    docker build -t "$image_name" -f windows-build/Dockerfile windows-build/

    # Run the build inside Docker
    print_info "Running Windows build in Docker container..."
    docker run --rm \
        -v "$PROJECT_ROOT:/app" \
        -e HOST_UID="$(id -u)" \
        -e HOST_GID="$(id -g)" \
        "$image_name" \
        /app/windows-build/build.sh

    # Copy artifacts to dist folder
    mkdir -p dist
    cp src-tauri/target/x86_64-pc-windows-gnu/release/bundle/nsis/*.exe dist/ 2>/dev/null || true
    # Also copy the raw exe if NSIS bundle wasn't created
    if ! ls dist/*.exe &>/dev/null; then
        cp src-tauri/target/x86_64-pc-windows-gnu/release/*.exe dist/ 2>/dev/null || true
    fi

    print_success "Windows build complete"
    echo "  Artifacts:"
    ls -1 dist/*.exe 2>/dev/null || true
}

# Main execution
main() {
    print_info "Sonar Build Script"
    print_info "Targets: ${TARGETS[*]}"
    echo ""

    if [[ "$CLEAN" == "true" ]]; then
        clean_build
    fi

    # Create dist directory
    mkdir -p dist

    local failed=()

    for target in "${TARGETS[@]}"; do
        echo ""
        case $target in
            macos)
                build_macos || failed+=("macos")
                ;;
            linux)
                build_linux || failed+=("linux")
                ;;
            windows)
                build_windows || failed+=("windows")
                ;;
        esac
    done

    echo ""
    print_info "Build Summary"
    echo "============="

    if [[ ${#failed[@]} -eq 0 ]]; then
        print_success "All builds completed successfully!"
    else
        print_warning "Some builds failed: ${failed[*]}"
    fi

    echo ""
    print_info "Build artifacts in: $PROJECT_ROOT/dist/"
    ls -la dist/ 2>/dev/null || print_warning "No artifacts found"
}

main
