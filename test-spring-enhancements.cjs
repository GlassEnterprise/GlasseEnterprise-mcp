const fs = require("fs");
const path = require("path");

// Import the built modules
const { extractEntities } = require("./build/scanner/astExtractor.js");

// Sample Spring Data Repository code
const springRepoCode = `
package com.example.repository;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.stereotype.Repository;
import java.util.List;
import java.util.Optional;

@Repository
public interface UserRepository extends JpaRepository<User, Long> {
    
    Optional<User> findByUsername(String username);
    
    List<User> findByEmailAndActive(String email, boolean active);
    
    @Query("SELECT u FROM User u WHERE u.status = ?1")
    List<User> findByStatus(String status);
    
    @Query(value = "SELECT * FROM users WHERE created_date > ?1", nativeQuery = true)
    List<User> findRecentUsers(Date since);
    
    void deleteByUsername(String username);
    
    long countByActive(boolean active);
}
`;

// Sample Spring Security Configuration code
const springSecurityCode = `
package com.example.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;

@Configuration
@EnableWebSecurity
public class SecurityConfig {
    
    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        http
            .authorizeRequests()
                .antMatchers("/api/public/**").permitAll()
                .antMatchers("/api/admin/**").hasRole("ADMIN")
                .antMatchers("/api/user/**").hasAnyRole("USER", "ADMIN")
                .anyRequest().authenticated()
            .and()
            .formLogin()
                .loginPage("/login")
                .permitAll()
            .and()
            .logout()
                .permitAll();
        return http.build();
    }
    
    @Bean
    public BCryptPasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder();
    }
}

@Component
public class CustomUserDetailsService implements UserDetailsService {
    
    @Autowired
    private UserRepository userRepository;
    
    @Override
    public UserDetails loadUserByUsername(String username) throws UsernameNotFoundException {
        User user = userRepository.findByUsername(username)
            .orElseThrow(() -> new UsernameNotFoundException("User not found"));
        return new CustomUserDetails(user);
    }
}
`;

// Test function
async function testSpringEnhancements() {
  console.log("🧪 Testing Spring Enhancements...\n");

  // Create test repository structure
  const testRepo = {
    repoRoot: "/test/repo",
    files: [
      {
        relPath: "src/main/java/com/example/repository/UserRepository.java",
        absPath:
          "/test/repo/src/main/java/com/example/repository/UserRepository.java",
        language: "java",
        content: springRepoCode,
      },
      {
        relPath: "src/main/java/com/example/config/SecurityConfig.java",
        absPath:
          "/test/repo/src/main/java/com/example/config/SecurityConfig.java",
        language: "java",
        content: springSecurityCode,
      },
    ],
  };

  try {
    // Extract entities
    const entities = await extractEntities([testRepo]);

    console.log(`✅ Total entities extracted: ${entities.length}\n`);

    // Filter and display Spring Data Repository entities
    const springRepos = entities.filter(
      (e) => e.type === "SpringDataRepository"
    );
    console.log(`📦 Spring Data Repositories found: ${springRepos.length}`);
    springRepos.forEach((repo) => {
      console.log(`  - ${repo.name}`);
      if (repo.entityType) console.log(`    Entity: ${repo.entityType}`);
      if (repo.baseInterface) console.log(`    Extends: ${repo.baseInterface}`);
      if (repo.customQueries && repo.customQueries.length > 0) {
        console.log(`    Custom queries: ${repo.customQueries.length}`);
      }
    });

    // Filter and display Security Components
    const securityComponents = entities.filter(
      (e) => e.type === "SecurityComponent"
    );
    console.log(`\n🔒 Security Components found: ${securityComponents.length}`);
    securityComponents.forEach((comp) => {
      console.log(`  - ${comp.name}`);
      if (comp.componentType) console.log(`    Type: ${comp.componentType}`);
      if (comp.securityAnnotations && comp.securityAnnotations.length > 0) {
        console.log(`    Annotations: ${comp.securityAnnotations.join(", ")}`);
      }
      if (comp.configuredPaths && comp.configuredPaths.length > 0) {
        console.log(`    Configured paths: ${comp.configuredPaths.join(", ")}`);
      }
    });

    // Filter and display Database Tables
    const tables = entities.filter((e) => e.type === "DatabaseTable");
    console.log(`\n🗄️ Database Tables detected: ${tables.length}`);
    tables.forEach((table) => {
      console.log(`  - ${table.name}`);
      if (table.entityClass)
        console.log(`    Entity class: ${table.entityClass}`);
    });

    // Filter and display Database Columns
    const columns = entities.filter((e) => e.type === "DatabaseColumn");
    console.log(`\n📊 Database Columns detected: ${columns.length}`);
    const columnsByTable = {};
    columns.forEach((col) => {
      if (!columnsByTable[col.table]) {
        columnsByTable[col.table] = [];
      }
      columnsByTable[col.table].push(col.name);
    });
    Object.entries(columnsByTable).forEach(([table, cols]) => {
      console.log(`  Table ${table}: ${cols.join(", ")}`);
    });

    console.log("\n✨ Spring enhancement test completed successfully!");
  } catch (error) {
    console.error("❌ Test failed:", error);
    process.exit(1);
  }
}

// Run the test
testSpringEnhancements();
