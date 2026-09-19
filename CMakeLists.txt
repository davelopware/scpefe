cmake_minimum_required(VERSION 3.20)

project(
    scpefe
    VERSION 0.1.0
    DESCRIPTION "Common core for the SCPEFE encrypted document editor"
    LANGUAGES C CXX
)

include(CTest)

add_library(scpefe SHARED
    src/scpefe.cpp
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
)
set_target_properties(scpefe PROPERTIES
    CXX_EXTENSIONS OFF
    VERSION ${PROJECT_VERSION}
    SOVERSION 0
)

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

    add_test(NAME scpefe.context-isolation COMMAND scpefe_context_test)
    add_test(NAME scpefe.diagnostic-health COMMAND scpefe_diagnostic health)
    set_tests_properties(scpefe.diagnostic-health PROPERTIES
        PASS_REGULAR_EXPRESSION
            "\"status\":\"ok\".*\"abi_version\":1.*\"host_monotonic_time_ms\":424242"
    )
endif()
