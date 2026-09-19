cmake_minimum_required(VERSION 3.20)

project(
    scpefe
    VERSION 0.1.0
    DESCRIPTION "Common core for the SCPEFE encrypted document editor"
    LANGUAGES C CXX
)

include(CTest)

option(SCPEFE_BUILD_NODE_ADDON "Build the Electron Node-API bridge" OFF)

find_library(SODIUM_LIBRARY NAMES sodium libsodium.so.23 REQUIRED)

add_library(scpefe SHARED
    src/abi/container_abi.cpp
    src/abi/context_abi.cpp
    src/abi/revision_abi.cpp
    src/container/password_container.cpp
    src/container/recoverable_password_container.cpp
    src/core/context.cpp
    src/core/host_services.cpp
    src/document/new_document.cpp
    src/format/cbor_reader.cpp
    src/format/cbor_writer.cpp
    src/format/diagnostic_json_writer.cpp
    src/format/revision_limits.cpp
    src/format/snapshot_revision.cpp
    src/format/text_validation.cpp
)
add_library(SCPEFE::scpefe ALIAS scpefe)

target_compile_features(scpefe PUBLIC cxx_std_20)
target_compile_definitions(scpefe
    PRIVATE
        SCPEFE_BUILDING_LIBRARY
        SCPEFE_VERSION_STRING="${PROJECT_VERSION}"
        SCPEFE_VERSION_MAJOR=${PROJECT_VERSION_MAJOR}
        SCPEFE_VERSION_MINOR=${PROJECT_VERSION_MINOR}
        SCPEFE_VERSION_PATCH=${PROJECT_VERSION_PATCH}
)
target_include_directories(scpefe
    PUBLIC
        $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
        $<INSTALL_INTERFACE:include>
    PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/src
)
target_link_libraries(scpefe PRIVATE ${SODIUM_LIBRARY})
set_target_properties(scpefe PROPERTIES
    CXX_EXTENSIONS OFF
    CXX_VISIBILITY_PRESET hidden
    VISIBILITY_INLINES_HIDDEN YES
    VERSION ${PROJECT_VERSION}
    SOVERSION 0
)

if(SCPEFE_BUILD_NODE_ADDON)
    if(NOT NODE_API_INCLUDE_DIR)
        message(FATAL_ERROR "NODE_API_INCLUDE_DIR is required for the Node-API bridge")
    endif()
    add_library(scpefe_electron_native MODULE apps/windows/native/addon.cpp)
    target_compile_features(scpefe_electron_native PRIVATE cxx_std_20)
    target_include_directories(scpefe_electron_native PRIVATE ${NODE_API_INCLUDE_DIR})
    target_link_libraries(scpefe_electron_native PRIVATE SCPEFE::scpefe)
    if(WIN32)
        if(NOT NODE_API_LIBRARY)
            message(FATAL_ERROR "NODE_API_LIBRARY is required on Windows")
        endif()
        target_link_libraries(scpefe_electron_native PRIVATE ${NODE_API_LIBRARY})
    endif()
    set_target_properties(scpefe_electron_native PROPERTIES
        PREFIX ""
        SUFFIX ".node"
        CXX_EXTENSIONS OFF
    )
endif()

if(MSVC)
    target_compile_options(scpefe PRIVATE /W4 /permissive-)
else()
    target_compile_options(scpefe PRIVATE -Wall -Wextra -Wpedantic)
endif()

add_executable(scpefe_diagnostic
    tools/scpefe_diagnostic.cpp
)
target_compile_features(scpefe_diagnostic PRIVATE cxx_std_20)
target_link_libraries(scpefe_diagnostic PRIVATE SCPEFE::scpefe)
set_target_properties(scpefe_diagnostic PROPERTIES
    CXX_EXTENSIONS OFF
    OUTPUT_NAME scpefe-diagnostic
)

if(BUILD_TESTING)
    add_executable(scpefe_context_test
        tests/context_test.c
    )
    target_link_libraries(scpefe_context_test PRIVATE SCPEFE::scpefe)

    add_executable(scpefe_revision_test
        tests/revision_test.c
    )
    target_link_libraries(scpefe_revision_test PRIVATE SCPEFE::scpefe)

    add_executable(scpefe_container_test
        tests/container_test.c
    )
    target_link_libraries(scpefe_container_test PRIVATE SCPEFE::scpefe)

    add_executable(scpefe_format_contract_test
        tests/format_contract_test.c
    )
    target_link_libraries(scpefe_format_contract_test PRIVATE SCPEFE::scpefe)

    add_executable(scpefe_new_document_test
        tests/new_document_test.c
    )
    target_link_libraries(scpefe_new_document_test PRIVATE SCPEFE::scpefe)

    add_test(NAME scpefe.context-isolation COMMAND scpefe_context_test)
    add_test(NAME scpefe.container-password-round-trip COMMAND scpefe_container_test)
    add_test(NAME scpefe.new-document-round-trip COMMAND scpefe_new_document_test)
    add_test(
        NAME scpefe.format-contract
        COMMAND scpefe_format_contract_test "${CMAKE_CURRENT_SOURCE_DIR}"
    )
    add_test(
        NAME scpefe.revision-round-trip
        COMMAND scpefe_revision_test
            "${CMAKE_CURRENT_BINARY_DIR}/snapshot-revision-v1.cbor"
    )
    add_test(
        NAME scpefe.diagnostic-revision
        COMMAND scpefe_diagnostic revision
            "${CMAKE_CURRENT_BINARY_DIR}/snapshot-revision-v1.cbor"
    )
    add_test(
        NAME scpefe.diagnostic-revision-content
        COMMAND scpefe_diagnostic revision
            "${CMAKE_CURRENT_BINARY_DIR}/snapshot-revision-v1.cbor"
            --include-content
    )
    add_test(NAME scpefe.diagnostic-health COMMAND scpefe_diagnostic health)
    set_tests_properties(scpefe.diagnostic-health PROPERTIES
        PASS_REGULAR_EXPRESSION
            "\"status\":\"ok\".*\"abi_version\":1.*\"host_monotonic_time_ms\":424242"
    )
    set_tests_properties(scpefe.diagnostic-revision PROPERTIES
        DEPENDS scpefe.revision-round-trip
        PASS_REGULAR_EXPRESSION "\"slot_identity_name\":\"Ada Lovelace\""
        FAIL_REGULAR_EXPRESSION "\"content\":"
    )
    set_tests_properties(scpefe.diagnostic-revision-content PROPERTIES
        DEPENDS scpefe.revision-round-trip
        PASS_REGULAR_EXPRESSION "\"content\":\"first line\\\\nsecond line\""
    )
endif()
